import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { RequestLimiter, SessionRateLimits } from "../dist/rate-limit.js";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { SessionStore } from "../dist/session-store.js";
import { createApplication } from "../dist/server.js";

const evidence = (t, input, config, expected, actual, trace) => t.diagnostic(JSON.stringify({
  kind: "acceptance-evidence", name: t.name, input, config, expected, actual, trace,
}));
const config = { baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKey: "fixture-only" };
const input = () => ({ messages: [{ role: "user", content: "hello" }], signal: new AbortController().signal });
async function collect(runtime, request = input()) { let text = ""; for await (const chunk of runtime.stream(request)) text += chunk; return text; }
const answer = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
  { headers: { "content-type": "application/json" } });

test("token bucket enforces burst, exact refill boundary and idempotent release", (t) => {
  let now = 0; const limits = { perMinute: 2, burst: 2, maxConcurrent: 1 };
  const bucket = new RequestLimiter(limits, () => now);
  const release = bucket.take();
  assert.throws(() => bucket.take(), { code: "MODEL_BUSY" });
  release(); release(); bucket.take()();
  assert.throws(() => bucket.take(), (error) => error.code === "RATE_LIMITED" && error.details.retryAfterMs === 30000);
  now = 29999; assert.throws(() => bucket.take(), { code: "RATE_LIMITED" });
  now = 30000; bucket.take()();
  now = 10000; bucket.snapshot(); now = 30000;
  assert.throws(() => bucket.take(), { code: "RATE_LIMITED" });
  evidence(t, "3 initial requests; refill at 29999/30000 ms; backward clock", limits,
    { accepted: 3, active: 0 }, bucket.snapshot(), [{ at: 0, outcome: "burst exhausted" }, { at: 30000, outcome: "one token refilled" }]);
});

test("session quota cannot reset early through inactive bucket eviction", () => {
  let now = 0; const buckets = new SessionRateLimits({ perMinute: 1, burst: 10 }, () => now);
  for (let n = 0; n < 10; n++) buckets.take("same");
  now = 300001;
  for (let n = 0; n < 5; n++) buckets.take("same");
  assert.throws(() => buckets.take("same"), { code: "SESSION_RATE_LIMITED" });
});

test("model rate quota prevents actual HTTP calls and classifies provider 429 without leaking body", async (t) => {
  let httpCalls = 0; const limits = { perMinute: 1, burst: 1, maxConcurrent: 1 };
  const runtime = new ChatCompletionsRuntime({ ...config, limits }, async () => { httpCalls++; return answer(); });
  assert.equal(await collect(runtime), "ok");
  await assert.rejects(collect(runtime), { code: "MODEL_RATE_LIMITED" });
  assert.equal(httpCalls, 1); assert.equal(runtime.limits().active, 0);
  const rejected = new ChatCompletionsRuntime(config, async () => new Response("secret provider payload", { status: 429 }));
  await assert.rejects(collect(rejected), (error) => error.code === "PROVIDER_RATE_LIMITED" && !error.message.includes("secret"));
  evidence(t, ["hello", "hello"], limits, { httpCalls: 1, second: "MODEL_RATE_LIMITED" },
    { httpCalls, limiter: runtime.limits() }, [{ request: 1, outcome: "ok" }, { request: 2, outcome: "rejected before HTTP" }]);
});

test("model concurrency rejects excess calls and releases slots after abort or transport failure", async (t) => {
  let httpCalls = 0; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const limits = { perMinute: 100, burst: 10, maxConcurrent: 1 };
  const runtime = new ChatCompletionsRuntime({ ...config, limits }, async (_url, init) => {
    httpCalls++; if (httpCalls > 1) throw new Error("fixture transport failure");
    entered(); return await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const first = collect(runtime, { ...input(), signal: controller.signal });
  const failed = assert.rejects(first); await started;
  await assert.rejects(collect(runtime), { code: "MODEL_BUSY" }); assert.equal(httpCalls, 1);
  controller.abort(new Error("fixture cancellation")); await failed;
  assert.equal(runtime.limits().active, 0);
  await assert.rejects(collect(runtime)); assert.equal(runtime.limits().active, 0);
  evidence(t, "overlap + abort + transport failure", limits, { httpCalls: 2, active: 0 },
    { httpCalls, limiter: runtime.limits() }, [{ outcome: "MODEL_BUSY before HTTP" }, { outcome: "abort released slot" }, { outcome: "transport failure released slot" }]);
});

test("tool approval wait releases model slot and follow-up consumes the shared rate quota", async (t) => {
  let httpCalls = 0; let approve; let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { approve = resolve; });
  const limits = { perMinute: 1, burst: 2, maxConcurrent: 1 };
  const runtime = new ChatCompletionsRuntime({ ...config, limits }, async () => {
    httpCalls++;
    return httpCalls === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: null,
      tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
      { headers: { "content-type": "application/json" } }) : answer();
  });
  const first = collect(runtime, { ...input(), toolDefinitions: [], callTool: async () => {
    entered(); await gate; return { content: "fixture data", isError: false };
  } });
  const rejected = assert.rejects(first, { code: "MODEL_RATE_LIMITED" }); await waiting;
  assert.equal(runtime.limits().active, 0);
  assert.equal(await collect(runtime), "ok"); approve(); await rejected;
  assert.equal(httpCalls, 2);
  evidence(t, "tool round waits while independent question completes", limits,
    { activeDuringApproval: 0, httpCalls: 2, followUp: "MODEL_RATE_LIMITED" }, { httpCalls, limiter: runtime.limits() },
    [{ outcome: "tool request" }, { outcome: "approval wait released HTTP slot" }, { outcome: "independent question completed" }, { outcome: "follow-up rejected before HTTP" }]);
});

async function client(url, t) {
  const ws = new WebSocket(url); const pending = new Map();
  ws.on("message", (raw) => { const frame = JSON.parse(raw); if (frame.type !== "res") return;
    const target = pending.get(frame.id); if (!target) return; pending.delete(frame.id);
    frame.ok ? target.resolve(frame.payload) : target.reject(Object.assign(new Error(frame.error.message), frame.error));
  });
  await once(ws, "open"); t.after(() => ws.terminate());
  return { ws, request(method, params = {}) { return new Promise((resolve, reject) => {
    const id = randomUUID(); pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ type: "req", id, method, params }));
  }); } };
}
const runtime = { info: { kind: "demo", label: "quota-fixture", model: null }, async *stream() { yield "ok"; } };
async function setup(t, limits) {
  const store = new SessionStore(":memory:");
  const app = await createApplication(store, runtime, 1000, undefined, 120000, undefined, undefined, limits);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); });
  const url = `ws://127.0.0.1:${app.server.address().port}/gateway`;
  return { store, url, app };
}
const generous = { perMinute: 600, burst: 100 };

test("Gateway session quota survives reconnect and duplicate sends consume no extra session quota", { timeout: 5000 }, async (t) => {
  const limits = { global: generous, connection: generous, session: { perMinute: 1, burst: 1 } };
  const { store, url } = await setup(t, limits); const first = await client(url, t); await first.request("connect");
  const { session } = await first.request("sessions.create");
  const params = { sessionId: session.id, clientRequestId: "same", content: "hello" };
  const accepted = await first.request("chat.send", params);
  assert.equal((await first.request("chat.send", params)).run.id, accepted.run.id);
  first.ws.terminate();
  const second = await client(url, t); await second.request("connect");
  await assert.rejects(second.request("chat.send", { ...params, clientRequestId: "new" }),
    (error) => error.code === "SESSION_RATE_LIMITED" && error.retryAfterMs > 0);
  assert.equal(store.history(session.id).runs.length, 1);
  evidence(t, [params, "duplicate", "reconnect/new request"], limits,
    { runs: 1, afterReconnect: "SESSION_RATE_LIMITED" }, { runs: store.history(session.id).runs.length }, store.eventsForRun(accepted.run.id));
});

test("Gateway global quota spans connections while abort and rejection remain available", { timeout: 5000 }, async (t) => {
  const limits = { global: { perMinute: 1, burst: 2 }, connection: generous, session: generous };
  const { store, url } = await setup(t, limits);
  const queued = store.accept(store.create().id, "queued-fixture", "abort this queued run");
  const first = await client(url, t); await first.request("connect");
  const second = await client(url, t); await second.request("connect");
  await assert.rejects(first.request("sessions.list"), { code: "GATEWAY_RATE_LIMITED" });
  await assert.rejects(second.request("sessions.list"), { code: "GATEWAY_RATE_LIMITED" });
  // Invalid IDs return ordinary business errors, proving controls reached dispatch after quota exhaustion.
  await assert.rejects(first.request("chat.abort", { runId: "missing" }), { code: "RUN_NOT_FOUND" });
  await assert.rejects(first.request("tools.decide", { runId: "missing", toolCallId: "missing", decision: "rejected" }), { code: "RUN_NOT_FOUND" });
  assert.equal((await first.request("chat.abort", { runId: queued.id })).run.status, "cancelled");
  evidence(t, "two connections exhaust global bucket; then reads/controls", limits,
    { reads: "GATEWAY_RATE_LIMITED", controls: "RUN_NOT_FOUND" }, { reads: "GATEWAY_RATE_LIMITED", controls: "RUN_NOT_FOUND" },
    [{ outcome: "connect accepted twice" }, { outcome: "read rejected across sockets" }, { outcome: "abort and rejection dispatched" }, ...store.eventsForRun(queued.id)]);
});

test("Gateway per-connection quota allows independent socket budget and preserves retry hint", { timeout: 5000 }, async (t) => {
  const limits = { global: generous, connection: { perMinute: 1, burst: 2 }, session: generous };
  const { url } = await setup(t, limits); const first = await client(url, t); await first.request("connect");
  await first.request("sessions.list");
  await assert.rejects(first.request("sessions.list"), (error) => error.code === "CONNECTION_RATE_LIMITED" && error.retryAfterMs > 0);
  const second = await client(url, t); await second.request("connect");
  assert.ok(Array.isArray((await second.request("sessions.list")).sessions));
});

test("Gateway new steer consumes session quota while accepted duplicate steer stays idempotent", { timeout: 5000 }, async (t) => {
  const limits = { global: generous, connection: generous, session: { perMinute: 1, burst: 1 } };
  const { store, url } = await setup(t, limits);
  // A durable running fixture isolates steer accounting from the initial send.
  const run = store.accept(store.create().id, "steer-fixture", "question"); store.start(run.id);
  const socket = await client(url, t); await socket.request("connect");
  const params = { runId: run.id, clientRequestId: "guidance", content: "be precise" };
  await socket.request("chat.steer", params); await socket.request("chat.steer", params);
  await assert.rejects(socket.request("chat.steer", { ...params, clientRequestId: "new-guidance" }), { code: "SESSION_RATE_LIMITED" });
  assert.equal(JSON.parse(store.getRun(run.id).steerTrace).length, 1);
});

test("model quota failure keeps its exact failure code in durable Run events", { timeout: 5000 }, async (t) => {
  const model = new ChatCompletionsRuntime({ ...config, limits: { perMinute: 1, burst: 1 } }, async () => answer());
  await collect(model);
  const store = new SessionStore(":memory:");
  const app = await createApplication(store, model); t.after(async () => { await app.close(); store.close(); });
  const run = app.gateway.coordinator.accept(store.create().id, "limited", "hello");
  for (let n = 0; n < 100 && store.getRun(run.id).status !== "failed"; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.getRun(run.id).status, "failed");
  const event = store.eventsForRun(run.id).find((item) => item.type === "run.failed");
  assert.equal(JSON.parse(event.payload).errorCode, "MODEL_RATE_LIMITED");
});
