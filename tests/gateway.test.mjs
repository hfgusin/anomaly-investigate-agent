import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { SessionStore } from "../dist/session-store.js";
import { createApplication } from "../dist/server.js";

async function client(url) {
  const ws = new WebSocket(url);
  ws.on("error", () => {});
  const bus = new EventEmitter();
  const pending = new Map(); const events = [];
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "event") { events.push(frame); bus.emit("event", frame); return; }
    const target = pending.get(frame.id);
    if (!target) return;
    pending.delete(frame.id); frame.ok ? target.resolve(frame.payload) : target.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
  });
  await once(ws, "open");
  return {
    ws, events,
    waitEvent(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const listener = (event) => { if (predicate(event)) { bus.off("event", listener); resolve(event); } };
        bus.on("event", listener);
      });
    },
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = randomUUID(); pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    },
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
test("Gateway handshake, persisted history, second-client events, and foreign Origin rejection", { timeout: 8000 }, async (t) => {
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "integration", model: null }, async *stream() { yield "hello"; } };
  const app = await createApplication(store, runtime);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); });
  const port = app.server.address().port;
  const url = `ws://127.0.0.1:${port}/gateway`;
  const first = await client(url);
  await assert.rejects(first.request("sessions.list"), { code: "NOT_CONNECTED" });
  const connection = await first.request("connect");
  assert.equal(connection.runtime.label, "integration");
  const second = await client(url); await second.request("connect");
  const { session } = await first.request("sessions.create");
  const { run } = await first.request("chat.send", { sessionId: session.id, content: "test", clientRequestId: "same-request" });
  // The provider completes synchronously before the next RPC is handled.
  const history = await second.request("chat.history", { sessionId: session.id });
  assert.equal(history.runs[0].status, "completed");
  assert.equal(history.runs[0].output, "hello");
  const { events } = await second.request("runs.events", { runId: run.id });
  assert.deepEqual(events.map((event) => event.type),
    ["run.accepted", "run.started", "model.context_ready", "run.completed"]);
  assert.equal(JSON.parse(history.runs[0].checkpoint).seq, events.length);
  const exported = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/trace.json`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const trace = await exported.json();
  assert.equal(trace.run.id, run.id);
  assert.equal(trace.run.output, 'hello');
  assert.equal(trace.events.at(-1).type, 'run.completed');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs/${randomUUID()}/trace.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/trace.json`, { method: 'POST' })).status, 405);
  assert.ok(second.events.some((frame) => frame.event === "run.updated" && frame.payload.run.id === run.id));
  const duplicate = await second.request("chat.send", { sessionId: session.id, content: "test", clientRequestId: "same-request" });
  assert.equal(duplicate.run.id, run.id);
  first.ws.close(); second.ws.close();
  const reconnected = await client(url); await reconnected.request("connect");
  assert.equal((await reconnected.request("chat.history", { sessionId: session.id })).runs.length, 1);
  reconnected.ws.close();
  const denied = new WebSocket(url, { origin: "https://untrusted.example" });
  const [, response] = await once(denied, "unexpected-response");
  assert.equal(response.statusCode, 403); response.resume(); denied.terminate(); denied.on("error", () => {});
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200); assert.match(await page.text(), /模型配置/);
  const script = await fetch(`http://127.0.0.1:${port}/client-state.js`); assert.equal(script.status, 200);
  t.diagnostic(JSON.stringify({ kind: "acceptance-evidence", name: t.name,
    input: { content: "test", clientRequestId: "same-request" }, config: { runtime: "local text fixture", clients: 2 },
    expected: { status: "completed", output: "hello", duplicateRuns: 1, foreignOrigin: 403 },
    actual: { status: history.runs[0].status, output: history.runs[0].output, duplicateRunId: duplicate.run.id,
      runId: run.id, foreignOrigin: response.statusCode }, trace: events }));
});

test("P0-3/P0-4: /new keeps a parent session and /reset clears only the child context", { timeout: 8000 }, async (t) => {
  const store = new SessionStore(":memory:"); const inputs = [];
  const runtime = { info: { kind: "demo", label: "session tree", model: null }, async *stream({ messages }) {
    inputs.push(messages); yield "done";
  } };
  const app = await createApplication(store, runtime);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); });
  const socket = await client(`ws://127.0.0.1:${app.server.address().port}/gateway`);
  await socket.request("connect");
  const parent = (await socket.request("sessions.create")).session;
  const marker = "P0-PARENT-MARKER";
  const first = (await socket.request("chat.send", { sessionId: parent.id, clientRequestId: "parent", content: marker })).run;
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === first.id && event.payload.run.status === "completed");
  const child = (await socket.request("sessions.new", { currentSessionId: parent.id })).session;
  assert.equal(child.parentId, parent.id);
  assert.equal(store.get(parent.id).archived, false);
  assert.equal((await socket.request("chat.history", { sessionId: parent.id })).runs[0].input, marker);
  assert.equal((await socket.request("chat.history", { sessionId: child.id })).runs.length, 0);
  const second = (await socket.request("chat.send", { sessionId: child.id, clientRequestId: "child", content: "child question" })).run;
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === second.id && event.payload.run.status === "completed");
  assert.deepEqual(inputs[1], [{ role: "user", content: "child question" }]);
  const reset = (await socket.request("sessions.reset", { sessionId: child.id })).session;
  assert.equal(reset.id, child.id); assert.equal(reset.parentId, parent.id); assert.equal(reset.generation, 1);
  assert.equal(reset.title, "child question");
  assert.equal((await socket.request("chat.history", { sessionId: child.id })).runs.length, 0);
  const third = (await socket.request("chat.send", { sessionId: child.id, clientRequestId: "after-reset", content: "fresh question" })).run;
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === third.id && event.payload.run.status === "completed");
  assert.deepEqual(inputs[2], [{ role: "user", content: "fresh question" }]);
  socket.ws.close();
});

test("SIGKILL followed by a fresh Gateway process preserves output and marks the run interrupted", { timeout: 10000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mirror-crash-"));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  async function boot() {
    const child = spawn(process.execPath, ["tests/fixtures/gateway-process.mjs", join(directory, "state.sqlite")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    for await (const line of lines) {
      const ready = JSON.parse(line);
      lines.close();
      return { child, ready };
    }
    throw new Error("Gateway did not start: " + stderr);
  }
  const first = await boot();
  const socket = await client(`ws://127.0.0.1:${first.ready.port}/gateway`);
  await socket.request("connect");
  const { session } = await socket.request("sessions.create");
  const { run } = await socket.request("chat.send", { sessionId: session.id, clientRequestId: "crash-case", content: "crash " + "x".repeat(1500) });
  const partial = await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === run.id && event.payload.run.output.length > 0);
  const exited = once(first.child, "exit");
  first.child.kill("SIGKILL"); await exited;
  const second = await boot();
  assert.equal(second.ready.recovered, 1);
  const restored = await client(`ws://127.0.0.1:${second.ready.port}/gateway`);
  await restored.request("connect");
  const history = await restored.request("chat.history", { sessionId: session.id });
  assert.equal(history.runs[0].status, "interrupted");
  assert.ok(history.runs[0].output.startsWith(partial.payload.run.output));
  assert.match(history.runs[0].error, /未自动重试/);
  restored.ws.close();
});

test("P0-6: stop a streaming turn, restart Gateway, and retain the stopped run", { timeout: 15000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mirror-stop-restart-"));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  async function boot() {
    const child = spawn(process.execPath, ["tests/fixtures/gateway-process.mjs", join(directory, "state.sqlite")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) { lines.close(); return { child, ready: JSON.parse(line) }; }
    throw new Error("Gateway did not start");
  }
  const first = await boot();
  const socket = await client(`ws://127.0.0.1:${first.ready.port}/gateway`);
  await socket.request("connect");
  const { session } = await socket.request("sessions.create");
  const { run } = await socket.request("chat.send", {
    sessionId: session.id, clientRequestId: "stop-restart", content: "stream " + "x".repeat(1500),
  });
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === run.id && event.payload.run.output.length > 0);
  await socket.request("chat.abort", { runId: run.id });
  const stopped = await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === run.id && event.payload.run.status === "cancelled");
  assert.ok(stopped.payload.run.output.length > 0);
  const exited = once(first.child, "exit"); first.child.kill("SIGKILL"); await exited;
  const second = await boot();
  assert.equal(second.ready.recovered, 0);
  const restored = await client(`ws://127.0.0.1:${second.ready.port}/gateway`);
  await restored.request("connect");
  const history = await restored.request("chat.history", { sessionId: session.id });
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, "cancelled");
  assert.equal(history.runs[0].output, stopped.payload.run.output);
  socket.ws.close(); restored.ws.close();
});

test("P0-7: two turns in one session stay ordered while another session completes", { timeout: 10000 }, async (t) => {
  const entered = deferred(); const release = deferred(); const inputs = [];
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "P0 concurrent", model: null }, async *stream({ messages }) {
    inputs.push(messages);
    if (messages.at(-1).content === "A1") { entered.resolve(); await release.promise; yield "answer A1"; }
    else yield messages.at(-1).content === "A2" ? "answer A2" : "answer B1";
  } };
  const app = await createApplication(store, runtime);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { release.resolve(); await app.close(); store.close(); });
  const socket = await client(`ws://127.0.0.1:${app.server.address().port}/gateway`);
  await socket.request("connect");
  const a = (await socket.request("sessions.create")).session;
  const b = (await socket.request("sessions.create")).session;
  const a1 = (await socket.request("chat.send", { sessionId: a.id, clientRequestId: "A1", content: "A1" })).run;
  await entered.promise;
  const a2 = (await socket.request("chat.send", { sessionId: a.id, clientRequestId: "A2", content: "A2" })).run;
  const b1 = (await socket.request("chat.send", { sessionId: b.id, clientRequestId: "B1", content: "B1" })).run;
  const bDone = await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === b1.id && event.payload.run.status === "completed");
  assert.equal(bDone.payload.run.output, "answer B1");
  assert.equal((await socket.request("chat.history", { sessionId: a.id })).runs.find((run) => run.id === a2.id).status, "queued");
  release.resolve();
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === a2.id && event.payload.run.status === "completed");
  const history = await socket.request("chat.history", { sessionId: a.id });
  assert.deepEqual(history.runs.map((run) => [run.id, run.output, run.status]), [
    [a1.id, "answer A1", "completed"], [a2.id, "answer A2", "completed"],
  ]);
  assert.deepEqual(inputs.find((messages) => messages.at(-1).content === "A2"), [
    { role: "user", content: "A1" }, { role: "assistant", content: "answer A1" }, { role: "user", content: "A2" },
  ]);
  socket.ws.close();
});

test("P0-7: a message during an active run steers the same run and is idempotent", { timeout: 10000 }, async (t) => {
  const entered = deferred(); const attempts = [];
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "P0 steer", model: null }, async *stream({ messages, signal }) {
    attempts.push(messages);
    if (attempts.length === 1) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    yield "guided answer";
  } };
  const app = await createApplication(store, runtime);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); });
  const socket = await client(`ws://127.0.0.1:${app.server.address().port}/gateway`);
  await socket.request("connect");
  const session = (await socket.request("sessions.create")).session;
  const { run } = await socket.request("chat.send", { sessionId: session.id, clientRequestId: "A1", content: "A1" });
  await entered.promise;
  const params = { runId: run.id, clientRequestId: "guide-1", content: "A2: 只用三句话回答" };
  const steered = await socket.request("chat.steer", params);
  const duplicate = await socket.request("chat.steer", params);
  assert.equal(steered.run.id, run.id); assert.equal(duplicate.run.id, run.id);
  const done = await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === run.id && event.payload.run.status === "completed");
  assert.equal(done.payload.run.output, "guided answer");
  const history = await socket.request("chat.history", { sessionId: session.id });
  assert.equal(history.runs.length, 1);
  const trace = JSON.parse(history.runs[0].steerTrace);
  assert.deepEqual(trace.map((entry) => entry.content), [params.content]);
  assert.ok(trace[0].appliedAt);
  assert.deepEqual(attempts[1], [
    { role: "user", content: "A1" },
    { role: "user", content: "用户在生成中补充了以下要求，请据此重新组织当前回答：\nA2: 只用三句话回答" },
  ]);
  socket.ws.close();
});

test("Multi-Agent Gateway exposes profiles, restores child cards through history and routes child approval", { timeout: 5000 }, async (t) => {
  const { ToolRegistry } = await import("../dist/tools/read-file.js");
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "mirror-team-gateway-"));
  writeFileSync(join(root, "note.txt"), "public fixture"); const tools = new ToolRegistry(root);
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "gateway-team-fixture", model: null }, async *stream(input) {
    if (input.messages.at(-1).content.startsWith("/team")) {
      const result = await input.callTool({ id: "dispatch", name: "delegate_task", arguments: JSON.stringify({ tasks: [{ key: "read", agentId: "reader", input: "read note.txt" }] }) });
      yield `[child:${JSON.parse(result.content).children[0].runId}]`; return;
    }
    const result = await input.callTool({ id: "read", name: "read_file", arguments: '{"path":"note.txt"}' }); yield result.content;
  } };
  const app = await createApplication(store, runtime, 2000, tools);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const socket = await client(`ws://127.0.0.1:${app.server.address().port}/gateway`); await socket.request("connect");
  assert.equal((await socket.request("agents.list")).maxConcurrent, 2);
  const { session } = await socket.request("sessions.create");
  const { run } = await socket.request("chat.send", { sessionId: session.id, clientRequestId: "team", content: "/team read a note" });
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === run.id && JSON.parse(event.payload.run.toolTrace).some((call) => call.status === "requested"));
  await socket.request("tools.decide", { runId: run.id, toolCallId: "dispatch", decision: "approved" });
  const approval = await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.parentRunId === run.id && JSON.parse(event.payload.run.toolTrace).some((call) => call.status === "requested"));
  const childId = approval.payload.run.id;
  const history = await socket.request("chat.history", { sessionId: session.id });
  assert.equal(history.childRuns[0].id, childId);
  assert.equal((await socket.request("runs.children", { runId: run.id })).runs[0].id, childId);
  await socket.request("tools.decide", { runId: childId, toolCallId: "read", decision: "approved" });
  await socket.waitEvent((event) => event.event === "run.updated" && event.payload.run.id === run.id && event.payload.run.status === "completed");
  assert.match(store.getRun(childId).output, /public fixture/); socket.ws.close();
});

test("Gateway lists and refreshes Skills, reports invalid files, then recovers", { timeout: 8000 }, async t => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { SkillRegistry } = await import('../dist/skills.js');
  const root = mkdtempSync(join(tmpdir(), 'gateway-skills-'));
  const folder = join(root, 'skills/brief'); mkdirSync(folder, { recursive: true });
  const file = join(folder, 'SKILL.md'); writeFileSync(file, 'first');
  const store = new SessionStore(':memory:');
  const runtime = { info: { kind: 'demo', label: 'skills' }, async *stream() { yield 'ok'; } };
  const app = await createApplication(store, runtime, 5000, undefined, 120000, new SkillRegistry(root));
  t.after(async () => { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const connection = await client(`ws://127.0.0.1:${app.server.address().port}/gateway`);
  await connection.request('connect');
  const before = await connection.request('skills.list');
  assert.equal(before.skills[0].command, '/brief');
  assert.equal(before.skills[0].instructions, undefined);
  writeFileSync(file, 'second');
  const after = await connection.request('skills.refresh');
  assert.notEqual(after.skills[0].version, before.skills[0].version);
  writeFileSync(file, '');
  assert.equal((await connection.request('skills.refresh')).errors[0].id, 'brief');
  assert.equal((await connection.request('skills.list')).errors.length, 1);
  writeFileSync(file, 'fixed');
  assert.equal((await connection.request('skills.refresh')).error, null);
  connection.ws.close();
});
