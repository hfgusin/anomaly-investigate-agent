import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, DEFAULT_AGENTS } from "../dist/agents.js";
import { SessionStore } from "../dist/session-store.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { ToolRegistry } from "../dist/tools/read-file.js";

const info = { kind: "demo", label: "multi-agent-fixture", model: null };
const pending = (run) => ["queued", "running"].includes(run.status);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 300; n++) { if (predicate()) return; await sleep(5); } throw new Error("fixture condition timed out"); }
function gate(signal) { return new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); }
const registry = (overrides = {}) => new AgentRegistry({ ...DEFAULT_AGENTS, ...overrides });
const task = (key, input = key) => ({ key, agentId: "reader", input });
const call = (tasks, id = "dispatch") => ({ id, name: "delegate_task", arguments: JSON.stringify({ tasks }) });
function trace(t, input, config, expected, actual, events) { t.diagnostic(JSON.stringify({ kind: "acceptance-evidence", name: t.name, input, config, expected, actual, trace: events })); }
function autoApprove(store, coordinatorRef, run) {
  for (const item of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) coordinatorRef().decideTool(run.id, item.id, "approved");
}
function refs(result) { return JSON.parse(result.content).children.map((child) => `${child.status} [child:${child.runId}]`).join("\n"); }

test("multi-agent runs two children, queues the third and returns isolated child results to parent", { timeout: 5000 }, async (t) => {
  const store = new SessionStore(":memory:"); const started = []; const releases = new Map(); let result; let active = 0; let peak = 0;
  const runtime = { info, async *stream(input) {
    const question = input.messages.at(-1).content;
    if (question.startsWith("/team")) { result = await input.callTool(call([task("a"), task("b"), task("c")])); yield refs(result); return; }
    assert.equal(input.messages.length, 1); assert.doesNotMatch(question, /parent-only-secret/);
    started.push(question); active++; peak = Math.max(peak, active);
    await new Promise((resolve) => releases.set(question, resolve)); active--; yield `answer ${question}`;
  } };
  let coordinator;
  coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run), 3000);
  t.after(async () => { for (const release of releases.values()) release(); await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "parallel", "/team parent-only-secret");
  await until(() => started.length === 2);
  assert.equal(store.children(parent.id).filter((run) => run.status === "queued").length, 1);
  releases.get("a")(); await until(() => started.length === 3); releases.get("b")(); releases.get("c")();
  await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "completed"); assert.equal(peak, 2);
  assert.deepEqual(JSON.parse(result.content).children.map((child) => child.answer), ["answer a", "answer b", "answer c"]);
  assert.equal(store.list().length, 1); // Internal child sessions are shown through their parent.
  assert.throws(() => coordinator.accept(store.children(parent.id)[0].sessionId, "inject", "unrelated"), { code: "CHILD_SESSION_MANAGED" });
  trace(t, [task("a"), task("b"), task("c")], { childConcurrency: 2 }, { peak: 2, children: 3, parent: "completed" },
    { peak, children: store.children(parent.id).length, parent: store.getRun(parent.id).status, result: JSON.parse(result.content) }, store.eventsForRun(parent.id));
});

test("multi-agent atomically rejects conflicting batches and reuses completed child ids", (t) => {
  const store = new SessionStore(":memory:"); t.after(() => store.close()); const agents = registry();
  const parent = store.accept(store.create().id, "parent", "/team fixture", agents.parentProfile(1000)); store.start(parent.id);
  const tasks = [{ key: "a", profile: agents.get("reader"), input: "first" }];
  const [child] = store.createChildren(parent.id, tasks, 4); store.start(child.id); store.appendOutput(child.id, "saved"); store.finish(child.id, "completed");
  assert.equal(store.createChildren(parent.id, tasks, 4)[0].id, child.id);
  assert.throws(() => store.createChildren(parent.id, [{ ...tasks[0], key: "b" }, { ...tasks[0], input: "different" }], 4), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(store.children(parent.id).length, 1);
  assert.throws(() => store.createChildren(parent.id, ["b", "c", "d", "e"].map((key) => ({ ...tasks[0], key })), 4), { code: "CHILD_LIMIT" });
  assert.equal(store.children(parent.id).length, 1);
});

test("multi-agent tool allowlist blocks recursive delegation and writes before approval", { timeout: 5000 }, async (t) => {
  const store = new SessionStore(":memory:"); let blockedApprovals = 0;
  const runtime = { info, async *stream(input) {
    if (input.messages.at(-1).content.startsWith("/team")) { yield refs(await input.callTool(call([task("a")]))); return; }
    for (const name of ["delegate_task", "write_file", "run_javascript"]) {
      const result = await input.callTool({ id: name, name, arguments: "{}" }); assert.equal(result.isError, true);
    }
    yield "blocked unsafe tools";
  } };
  let coordinator;
  coordinator = new RunCoordinator(store, runtime, (run) => {
    if (run.parentRunId) blockedApprovals += JSON.parse(run.toolTrace).filter((item) => item.status === "requested").length;
    else autoApprove(store, () => coordinator, run);
  });
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "block", "/team block"); await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "completed"); assert.equal(blockedApprovals, 0);
  assert.deepEqual(JSON.parse(store.children(parent.id)[0].toolTrace).map((tool) => tool.status), ["blocked", "blocked", "blocked"]);
});

test("multi-agent parent stop cancels running and queued children without later aggregation", { timeout: 5000 }, async (t) => {
  const store = new SessionStore(":memory:"); let aggregated = false;
  const runtime = { info, async *stream(input) {
    if (input.messages.at(-1).content.startsWith("/team")) { await input.callTool(call([task("a"), task("b"), task("c")])); aggregated = true; yield "wrong"; }
    else await gate(input.signal);
  } };
  let coordinator; coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run));
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "stop", "/team stop"); await until(() => coordinator.agentStatus().active === 2);
  coordinator.cancel(parent.id); await until(() => coordinator.agentStatus().active === 0);
  assert.equal(aggregated, false); assert.equal(store.getRun(parent.id).status, "cancelled");
  assert.deepEqual(store.children(parent.id).map((child) => child.status), ["cancelled", "cancelled", "cancelled"]);
  trace(t, "stop parent with 2 running + 1 queued children", { maxConcurrent: 2 }, { active: 0, aggregated: false },
    { active: coordinator.agentStatus().active, aggregated, children: store.children(parent.id).map((child) => child.status) }, store.eventsForRun(parent.id));
});

test("multi-agent child timeout returns explicit failure without promoting partial output to answer", { timeout: 5000 }, async (t) => {
  const store = new SessionStore(":memory:"); let result;
  const agents = registry({ agents: DEFAULT_AGENTS.agents.map((a) => ({ ...a, timeoutMs: 40 })) });
  const runtime = { info, async *stream(input) {
    if (input.messages.at(-1).content.startsWith("/team")) { result = await input.callTool(call([task("slow")])); yield refs(result); }
    else { yield "unverified partial"; await gate(input.signal); }
  } };
  let coordinator; coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run), 2000, undefined, 120000, undefined, agents);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "timeout", "/team timeout"); await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "completed");
  const [child] = JSON.parse(result.content).children;
  assert.equal(child.status, "failed"); assert.equal(child.failureCode, "TIMEOUT"); assert.equal(child.answer, null);
  assert.equal(store.children(parent.id)[0].output, "unverified partial");
  trace(t, "child hangs after partial output", { timeoutMs: 40 }, { childStatus: "failed", code: "TIMEOUT", answer: null }, child, store.eventsForRun(store.children(parent.id)[0].id));
});

test("multi-agent restart reuses completed child and keeps unfinished child's approval pending", { timeout: 5000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mirror-team-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "note.txt"), "saved fixture"); const tools = new ToolRegistry(root);
  const path = join(root, "state.sqlite"); let store = new SessionStore(path); let coordinator; let completedExecutions = 0; let reads = 0;
  const runtime = { info, async *stream(input) {
    const question = input.messages.at(-1).content;
    if (question.startsWith("/team")) {
      // Parent recovery receives durable results directly in context.
      if (question.includes("已保存检查点")) { yield store.children(parentId).map((child) => `[child:${child.id}]`).join(" "); return; }
      yield refs(await input.callTool(call([task("done"), task("read")]))); return;
    }
    if (question.startsWith("done")) { completedExecutions++; yield "already done"; return; }
    if (question.includes("已保存检查点")) { assert.match(question, /saved fixture/); yield "restored answer"; return; }
    await input.callTool({ id: "read-file", name: "read_file", arguments: JSON.stringify({ path: "note.txt" }) }); reads++; yield "read result";
  } };
  const publish = (run) => { if (!run.parentRunId) autoApprove(store, () => coordinator, run); };
  coordinator = new RunCoordinator(store, runtime, publish, 3000, tools);
  const parentId = coordinator.accept(store.create().id, "restart", "/team restart").id;
  await until(() => store.children(parentId).some((child) => JSON.parse(child.toolTrace).some((tool) => tool.status === "requested")));
  const originalIds = store.children(parentId).map((child) => child.id);
  await coordinator.shutdown(); store.close();
  store = new SessionStore(path); store.requeueResearchRuns(); store.recoverInterrupted();
  coordinator = new RunCoordinator(store, runtime, publish, 3000, tools);
  t.after(async () => { await coordinator.shutdown(); await tools.close(); store.close(); });
  coordinator.resumeQueuedResearchRuns();
  const child = store.children(parentId).find((item) => item.delegationKey === "read");
  await until(() => store.getRun(child.id).status === "running");
  assert.equal(JSON.parse(store.getRun(child.id).toolTrace)[0].status, "requested"); assert.equal(reads, 0);
  coordinator.decideTool(child.id, "read-file", "approved");
  await until(() => !pending(store.getRun(parentId)));
  assert.equal(store.getRun(parentId).status, "completed"); assert.equal(completedExecutions, 1);
  assert.deepEqual(store.children(parentId).map((item) => item.id), originalIds);
  assert.equal(JSON.parse(store.getRun(child.id).toolTrace)[0].status, "completed");
  trace(t, "restart while one child complete and one awaits approval", { database: "temporary SQLite", maxConcurrent: 2 },
    { completedExecutions: 1, sameChildIds: true, parent: "completed" }, { completedExecutions, originalIds, restoredIds: store.children(parentId).map((item) => item.id), parent: store.getRun(parentId).status }, store.eventsForRun(parentId));
});

test("multi-agent recovery cancels orphan child after durable parent stop", (t) => {
  const store = new SessionStore(":memory:"); t.after(() => store.close()); const agents = registry();
  const parent = store.accept(store.create().id, "parent", "/team orphan", agents.parentProfile(1000)); store.start(parent.id);
  const [child] = store.createChildren(parent.id, [{ key: "a", profile: agents.get("reader"), input: "task" }], 4);
  store.finish(parent.id, "cancelled"); // Simulate crash between parent stop and child stop.
  store.requeueResearchRuns(); store.recoverInterrupted();
  assert.equal(store.getRun(child.id).status, "cancelled"); assert.equal(store.queuedResearchRuns().length, 0);
});

test("multi-agent SIGKILL recovery retains child ids and never reruns committed child", { timeout: 8000 }, async (t) => {
  const { spawn } = await import("node:child_process"); const { once } = await import("node:events");
  const { readFileSync } = await import("node:fs"); const { crashRuntime } = await import("./fixtures/multi-agent-process.mjs");
  const root = mkdtempSync(join(tmpdir(), "mirror-team-kill-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite"); const log = join(root, "executions.txt");
  const child = spawn(process.execPath, [new URL("./fixtures/multi-agent-process.mjs", import.meta.url).pathname, path, log], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const marker = await new Promise((resolve, reject) => {
    let text = ""; child.stdout.on("data", (part) => { text += part; if (text.includes("\n")) resolve(JSON.parse(text.trim())); });
    child.on("error", reject); child.on("exit", (code) => reject(new Error(`process exited early ${code}`)));
  });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const store = new SessionStore(path); store.requeueResearchRuns(); store.recoverInterrupted(); let coordinator;
  coordinator = new RunCoordinator(store, crashRuntime(store, log), (run) => autoApprove(store, () => coordinator, run));
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  coordinator.resumeQueuedResearchRuns(); await until(() => !pending(store.getRun(marker.parentId)));
  assert.equal(store.getRun(marker.parentId).status, "completed");
  assert.deepEqual(store.children(marker.parentId).map((item) => item.id), marker.children);
  const executions = readFileSync(log, "utf8").trim().split("\n"); assert.equal(executions.filter((value) => value === "done").length, 1);
  trace(t, "SIGKILL after first child result committed", { runtime: "separate process fixture" }, { committedChildExecutions: 1, stableChildIds: true },
    { executions, before: marker.children, after: store.children(marker.parentId).map((item) => item.id), parent: store.getRun(marker.parentId).status }, store.eventsForRun(marker.parentId));
});

test("multi-agent parent waiting does not hold the sole model HTTP slot", { timeout: 5000 }, async (t) => {
  const { ChatCompletionsRuntime } = await import("../dist/providers/chat-completions.js");
  let requests = 0;
  const runtime = new ChatCompletionsRuntime({ baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKey: "fixture", limits: { perMinute: 60, burst: 8, maxConcurrent: 1 } }, async (_url, init) => {
    requests++; const body = JSON.parse(init.body); const result = body.messages.find((message) => message.role === "tool");
    const parent = body.messages.some((message) => message.role === "user" && message.content.startsWith("/team"));
    const message = result ? { content: refs({ content: result.content }) } : parent ? { content: null,
      tool_calls: [{ id: "dispatch", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ tasks: [task("a"), task("b")] }) } }] } : { content: "child answer" };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }), { headers: { "content-type": "application/json" } });
  });
  const store = new SessionStore(":memory:"); let coordinator;
  coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run), 2000, undefined, 120000, undefined, registry({ maxConcurrent: 1 }));
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "single-slot", "/team single model slot"); await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "completed"); assert.equal(requests, 4); assert.equal(runtime.limits().active, 0);
  trace(t, "parent + two children with one model HTTP slot", { modelMaxConcurrent: 1, childMaxConcurrent: 1 }, { requests: 4, status: "completed" },
    { requests, status: store.getRun(parent.id).status, limiter: runtime.limits() }, store.eventsForRun(parent.id));
});

test("multi-agent profile concurrency is enforced independently of the global child limit", { timeout: 5000 }, async (t) => {
  const store = new SessionStore(":memory:"); const releases = new Map(); const started = [];
  const reader = { ...DEFAULT_AGENTS.agents[0], maxConcurrent: 1 };
  const agents = registry({ agents: [reader, { ...reader, id: "other" }] });
  const runtime = { info, async *stream(input) {
    const text = input.messages.at(-1).content;
    if (text.startsWith("/team")) { yield refs(await input.callTool(call([task("a"), task("b"), { ...task("c"), agentId: "other" }]))); return; }
    started.push(text); await new Promise((resolve) => releases.set(text, resolve)); yield text;
  } };
  let coordinator; coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run), 2000, undefined, 120000, undefined, agents);
  t.after(async () => { for (const release of releases.values()) release(); await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "profile-cap", "/team cap"); await until(() => started.length === 2);
  assert.deepEqual(started, ["a", "c"]); releases.get("a")(); await until(() => started.length === 3);
  releases.get("b")(); releases.get("c")(); await until(() => !pending(store.getRun(parent.id))); assert.equal(store.getRun(parent.id).status, "completed");
});

test("multi-agent configuration rejects write capabilities and parent cannot claim success without delegation", { timeout: 5000 }, async (t) => {
  assert.throws(() => registry({ agents: [{ ...DEFAULT_AGENTS.agents[0], tools: ["write_file"] }] }), { code: "INVALID_AGENT_CONFIG" });
  assert.throws(() => registry({ agents: [{ ...DEFAULT_AGENTS.agents[0], id: undefined }] }), { code: "INVALID_AGENT_CONFIG" });
  const store = new SessionStore(":memory:"); const coordinator = new RunCoordinator(store, { info, async *stream() { yield "I delegated everything"; } }, () => {});
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "pretend", "/team pretend"); await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "failed");
  assert.equal(JSON.parse(store.eventsForRun(parent.id).at(-1).payload).errorCode, "DELEGATION_REQUIRED");
});

test("multi-agent completed research with insufficient evidence is returned as no answer", { timeout: 5000 }, async (t) => {
  const { SkillRegistry } = await import("../dist/skills.js");
  const store = new SessionStore(":memory:"); const tools = new ToolRegistry("workspace", "data/hotpotqa/validation-sample.json"); let result;
  const runtime = { info, async *stream(input) {
    if (input.messages.at(-1).content.startsWith("/team")) {
      result = await input.callTool(call([{ key: "missing", agentId: "researcher", input: "question without evidence" }])); yield refs(result);
    } else yield "证据不足，未取得资料。";
  } };
  let coordinator; coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run), 1000, tools, 120000, new SkillRegistry(process.cwd()));
  t.after(async () => { await coordinator.shutdown(); await tools.close(); store.close(); });
  const parent = coordinator.accept(store.create().id, "insufficient", "/team missing evidence"); await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "completed"); assert.equal(result.isError, true);
  const [child] = JSON.parse(result.content).children;
  assert.equal(child.status, "completed"); assert.equal(child.outcome, "insufficient_evidence");
  assert.equal(child.answer, null); assert.equal(child.failureCode, "RESEARCH_INSUFFICIENT_EVIDENCE");
});

test("multi-agent single child stop releases model slot before parent aggregates cancellation", { timeout: 5000 }, async (t) => {
  const { ChatCompletionsRuntime } = await import("../dist/providers/chat-completions.js");
  let childEntered = false;
  const runtime = new ChatCompletionsRuntime({ baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKey: "fixture", limits: { perMinute: 60, burst: 8, maxConcurrent: 1 } }, async (_url, init) => {
    const body = JSON.parse(init.body); const result = body.messages.find((message) => message.role === "tool");
    const parent = body.messages.some((message) => message.role === "user" && message.content.startsWith("/team"));
    if (!parent) { childEntered = true; return await gate(init.signal); }
    const message = result ? { content: refs({ content: result.content }) } : { content: null,
      tool_calls: [{ id: "dispatch", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ tasks: [task("slow")] }) } }] };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: result ? "stop" : "tool_calls" }] }), { headers: { "content-type": "application/json" } });
  });
  const store = new SessionStore(":memory:"); let coordinator;
  coordinator = new RunCoordinator(store, runtime, (run) => autoApprove(store, () => coordinator, run), 2000);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const parent = coordinator.accept(store.create().id, "cancel-one", "/team cancel a child"); await until(() => childEntered);
  coordinator.cancel(store.children(parent.id)[0].id); await until(() => !pending(store.getRun(parent.id)));
  assert.equal(store.getRun(parent.id).status, "completed"); assert.equal(runtime.limits().active, 0);
  assert.equal(JSON.parse(JSON.parse(store.getRun(parent.id).toolTrace)[0].result).children[0].status, "cancelled");
});
