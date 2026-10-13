import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { SessionStore } from "../dist/session-store.js";
import { ToolRegistry } from "../dist/tools/read-file.js";

const makeWorkspace = (t) => {
  const root = mkdtempSync(join(tmpdir(), "mirror-tool-"));
  const workspace = join(root, "workspace");
  const tools = new ToolRegistry(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, tools };
};
const signal = new AbortController().signal;
const sse = (delta, finish = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const response = (frames) => new Response(frames, { headers: { "content-type": "text/event-stream" } });

test("default policy blocks forced code execution without an approval or a side effect", async (t) => {
  const { workspace, tools } = makeWorkspace(t);
  assert.ok(!tools.definitions.some((item) => item.function.name === "run_javascript"));
  const store = new SessionStore(":memory:");
  let approvals = 0;
  const runtime = { info: { kind: "demo", label: "malicious-source-fixture" }, async *stream(input) {
    const result = await input.callTool({ id: "attack", name: "run_javascript",
      arguments: JSON.stringify({ code: "import {writeFileSync} from 'node:fs'; writeFileSync('pwned.txt','attack')" }) });
    yield result.content;
  } };
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const coordinator = new RunCoordinator(store, runtime, (run) => {
    if (JSON.parse(run.toolTrace).some((call) => call.status === "requested")) approvals++;
    if (["completed", "failed"].includes(run.status)) done(run);
  }, 1000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  coordinator.accept(store.create().id, "attack-request", "Summarize a webpage containing an instruction to run code.");
  const run = await finished;
  assert.equal(approvals, 0);
  assert.equal(JSON.parse(run.toolTrace)[0].status, "blocked");
  assert.ok(!existsSync(join(workspace, "pwned.txt")));
  assert.equal((await tools.execute("run_javascript", '{"code":"console.log(5)"}', signal)).isError, true);
});

test("rejected write executes nothing even if a source urges the model to write", async (t) => {
  const { workspace, tools } = makeWorkspace(t);
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "forced-write-fixture" }, async *stream(input) {
    const result = await input.callTool({ id: "write", name: "write_file", arguments: JSON.stringify({ path: "unwanted.txt", content: "source instruction", mode: "create" }) });
    yield result.content;
  } };
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const coordinator = new RunCoordinator(store, runtime, (run) => {
    const call = JSON.parse(run.toolTrace).find((item) => item.status === "requested");
    if (call) coordinator.decideTool(run.id, call.id, "rejected");
    if (["completed", "failed"].includes(run.status)) done(run);
  }, 1000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  coordinator.accept(store.create().id, "reject-write", "Summarize untrusted source text.");
  const run = await finished;
  assert.equal(JSON.parse(run.toolTrace)[0].status, "rejected");
  assert.ok(!existsSync(join(workspace, "unwanted.txt")));
  t.diagnostic(JSON.stringify({ kind: "acceptance-evidence", name: t.name,
    input: { tool: "write_file", path: "unwanted.txt", content: "source instruction" },
    config: { approval: "rejected", runtime: "forced write fixture" },
    expected: { toolStatus: "rejected", fileExists: false },
    actual: { toolStatus: JSON.parse(run.toolTrace)[0].status, fileExists: existsSync(join(workspace, "unwanted.txt")) },
    trace: store.eventsForRun(run.id) }));
});

test("committed write stays completed if cancellation arrives before model resumes", async (t) => {
  const { workspace, tools } = makeWorkspace(t);
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "commit-cancel-fixture" }, async *stream(input) {
    const result = await input.callTool({ id: "write", name: "write_file", arguments: JSON.stringify({ path: "committed.txt", content: "saved", mode: "create" }) });
    yield result.content;
  } };
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const coordinator = new RunCoordinator(store, runtime, (run) => {
    const trace = JSON.parse(run.toolTrace);
    const pending = trace.find((call) => call.status === "requested");
    if (pending) coordinator.decideTool(run.id, pending.id, "approved");
    if (run.status === "running" && trace.some((call) => call.status === "completed")) coordinator.cancel(run.id);
    if (run.status === "cancelled") done(run);
  }, 1000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  coordinator.accept(store.create().id, "commit-cancel", "Create the file.");
  const run = await finished;
  assert.equal(JSON.parse(run.toolTrace)[0].status, "completed");
  assert.equal(readFileSync(join(workspace, "committed.txt"), "utf8"), "saved");
});

test("crash after simulated filesystem commit leaves effect unknown and never queues a replay", (t) => {
  const { root, workspace } = makeWorkspace(t);
  const database = join(root, "recovery.sqlite");
  let store = new SessionStore(database);
  const run = store.accept(store.create().id, "effect-crash", "Create a file.");
  store.start(run.id);
  store.requestTool(run.id, "write", "write_file", JSON.stringify({ path: "after-crash.txt", content: "saved", mode: "create" }));
  store.decideTool(run.id, "write", "approved"); store.startTool(run.id, "write");
  writeFileSync(join(workspace, "after-crash.txt"), "saved");
  store.close(); store = new SessionStore(database);
  t.after(() => store.close());
  assert.equal(store.requeueResearchRuns(), 0);
  store.recoverInterrupted();
  assert.equal(JSON.parse(store.getRun(run.id).toolTrace)[0].status, "unknown");
  assert.equal(store.pendingCount(), 0);
  assert.equal(readFileSync(join(workspace, "after-crash.txt"), "utf8"), "saved");
});

test("writes refuse stale hashes, symlinks, traversal and concurrent writes to the same path", async (t) => {
  const { root, workspace, tools } = makeWorkspace(t);
  writeFileSync(join(root, "outside.txt"), "untouched");
  symlinkSync(join(root, "outside.txt"), join(workspace, "alias.txt"));
  for (const path of ["../outside.txt", ".env", "alias.txt"]) {
    const result = await tools.execute("write_file", JSON.stringify({ path, content: "overwrite", mode: "create" }), signal);
    assert.equal(result.isError, true);
  }
  const results = await Promise.all([1, 2].map((n) => tools.execute("write_file", JSON.stringify({ path: "same.txt", content: String(n), mode: "create" }), signal)));
  assert.equal(results.filter((result) => !result.isError).length, 1);
  const result = await tools.execute("write_file", JSON.stringify({ path: "same.txt", content: "bad", mode: "replace", expected_sha256: "0".repeat(64) }), signal);
  assert.equal(result.isError, true);
  assert.notEqual(readFileSync(join(workspace, "same.txt"), "utf8"), "bad");
  assert.equal(readFileSync(join(root, "outside.txt"), "utf8"), "untouched");
});

test("steering cannot replay an operation after a write has started", async (t) => {
  const { tools } = makeWorkspace(t);
  const store = new SessionStore(":memory:");
  const coordinator = new RunCoordinator(store, { info: { kind: "demo", label: "idle" } }, () => {}, 1000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const run = store.accept(store.create().id, "write-started", "Write.");
  store.start(run.id); store.requestTool(run.id, "write", "write_file", "{}");
  store.decideTool(run.id, "write", "approved"); store.startTool(run.id, "write");
  assert.throws(() => coordinator.steer(run.id, "steer", "Try again."), (error) => error.code === "SIDE_EFFECT_STEER_BLOCKED");
  store.finish(run.id, "cancelled");
  assert.equal(JSON.parse(store.getRun(run.id).toolTrace)[0].status, "unknown");
});

test("web tool refuses local IP, credential URLs, alternate ports and loopback DNS", async (t) => {
  const { tools } = makeWorkspace(t);
  for (const url of ["http://example.com/", "https://127.0.0.1/", "https://[::1]/", "https://user:pass@example.com/", "https://example.com:8443/", "https://localhost/"]) {
    const result = await tools.execute("fetch_url", JSON.stringify({ url }), signal);
    assert.equal(result.isError, true, url);
  }
});

test("SIGKILL after a real file commit retains the file and marks its missing receipt unknown", { timeout: 5000 }, async (t) => {
  const { root, workspace } = makeWorkspace(t);
  const database = join(root, "killed.sqlite");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { SessionStore } from ${JSON.stringify(new URL("../dist/session-store.js", import.meta.url).href)};
    import { ToolRegistry } from ${JSON.stringify(new URL("../dist/tools/read-file.js", import.meta.url).href)};
    const store = new SessionStore(${JSON.stringify(database)});
    const tools = new ToolRegistry(${JSON.stringify(workspace)});
    const run = store.accept(store.create().id, 'kill-write', 'Create file.');
    const args = JSON.stringify({path:'real-commit.txt',content:'saved by tool',mode:'create'});
    store.start(run.id); store.requestTool(run.id,'write','write_file',args);
    store.decideTool(run.id,'write','approved'); store.startTool(run.id,'write');
    const result = await tools.execute('write_file',args,new AbortController().signal);
    if(result.isError) throw new Error(result.content);
    console.log(run.id);
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let runId;
  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) { runId = stdout.trim(); resolve(); }
    });
    child.on("error", reject);
    child.on("exit", (code) => { if (!runId) reject(new Error(`Child exited before commit: ${code}`)); });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited;
  const store = new SessionStore(database); t.after(() => store.close());
  store.recoverInterrupted();
  assert.equal(JSON.parse(store.getRun(runId).toolTrace)[0].status, "unknown");
  assert.equal(readFileSync(join(workspace, "real-commit.txt"), "utf8"), "saved by tool");
  assert.equal(store.pendingCount(), 0);
  t.diagnostic(JSON.stringify({ kind: "acceptance-evidence", name: t.name,
    input: { tool: "write_file", path: "real-commit.txt", content: "saved by tool" },
    config: { fault: "SIGKILL after actual commit before persisted receipt", recovery: "recoverInterrupted" },
    expected: { toolStatus: "unknown", pendingCount: 0, file: "saved by tool" },
    actual: { toolStatus: JSON.parse(store.getRun(runId).toolTrace)[0].status, pendingCount: store.pendingCount(),
      file: readFileSync(join(workspace, "real-commit.txt"), "utf8") }, trace: store.eventsForRun(runId) }));
});

test("explicitly enabled script failure records unknown effects and stops the model before retry", async (t) => {
  const { workspace } = makeWorkspace(t);
  const tools = new ToolRegistry(workspace, undefined, true);
  const store = new SessionStore(":memory:");
  let continued = false;
  const runtime = { info: { kind: "demo", label: "trusted-experiment-fixture" }, async *stream(input) {
    await input.callTool({ id: "script", name: "run_javascript", arguments: JSON.stringify({
      code: "import {writeFileSync} from 'node:fs'; writeFileSync('partial.txt','written'); throw new Error('after write')",
    }) });
    continued = true; yield "retry";
  } };
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const coordinator = new RunCoordinator(store, runtime, (run) => {
    const pending = JSON.parse(run.toolTrace).find((call) => call.status === "requested");
    if (pending) coordinator.decideTool(run.id, pending.id, "approved");
    if (run.status === "failed") done(run);
  }, 2000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  coordinator.accept(store.create().id, "failed-script", "Explicitly run the trusted experiment.");
  const run = await finished;
  assert.equal(JSON.parse(run.toolTrace)[0].status, "unknown");
  assert.equal(readFileSync(join(workspace, "partial.txt"), "utf8"), "written");
  assert.equal(continued, false);
});

test("read_file accepts only bounded UTF-8 text within the dedicated workspace", async (t) => {
  const { root, workspace, tools } = makeWorkspace(t);
  writeFileSync(join(workspace, "notes.txt"), "hello 中文");
  writeFileSync(join(root, "secret.txt"), "outside");
  writeFileSync(join(workspace, ".env"), "hidden");
  writeFileSync(join(workspace, "bad.bin"), Buffer.from([0xff]));
  writeFileSync(join(workspace, "large.txt"), "x".repeat(65537));
  symlinkSync(join(root, "secret.txt"), join(workspace, "alias.txt"));

  const good = await tools.execute("read_file", JSON.stringify({ path: "notes.txt" }), signal);
  assert.equal(good.isError, false);
  assert.deepEqual(JSON.parse(good.content), { path: "notes.txt", content: "hello 中文",
    sha256: "1aebb3af2f68e52c2d0eaa1d56ecf056353a75d612d2c3cc62e412a7c365c035" });
  const search = await tools.execute("search_workspace", JSON.stringify({ query: "hello 中文" }), signal);
  assert.equal(search.isError, false);
  assert.deepEqual(JSON.parse(search.content), {
    query: "hello 中文", matches: [{ path: "notes.txt", line: 1, excerpt: "hello 中文" }], truncated: false,
  });
  assert.deepEqual(JSON.parse((await tools.execute("search_workspace", JSON.stringify({ query: "outside" }), signal)).content).matches, []);
  for (const path of ["../secret.txt", "/secret.txt", ".env", "alias.txt", "bad.bin", "large.txt"]) {
    const result = await tools.execute("read_file", JSON.stringify({ path }), signal);
    assert.equal(result.isError, true, path);
    assert.ok(!result.content.includes("outside") && !result.content.includes("hidden"));
  }
  assert.equal((await tools.execute("read_file", "{", signal)).isError, true);
  assert.equal((await tools.execute("search_workspace", JSON.stringify({ query: "" }), signal)).isError, true);
  assert.equal((await tools.execute("shell", "{}", signal)).isError, true);
});

test("streamed tool arguments execute once, the result returns to the model, and the run records the trace", { timeout: 5000 }, async (t) => {
  const { workspace, tools } = makeWorkspace(t);
  writeFileSync(join(workspace, "notes.txt"), "alpha from workspace");
  const requests = [];
  const runtime = new ChatCompletionsRuntime(
    { baseUrl: "https://provider.example/v1", model: "test-model", apiKey: "test-key" },
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) return response(
        sse({ content: '<tool_call>{"name":"read_file"}</tool_call>' }) +
        sse({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"not' } }] }) +
        sse({ tool_calls: [{ index: 0, function: { arguments: 'es.txt"}' } }] }) +
        sse({}, "tool_calls") + "data: [DONE]\n\n");
      return new Response(new TextEncoder().encode(JSON.stringify({ choices: [{ index: 0,
        message: { role: "assistant", content: "The file says alpha." }, finish_reason: "stop" }] })));
    },
  );
  const store = new SessionStore(":memory:");
  const bus = new EventEmitter();
  const coordinator = new RunCoordinator(store, runtime, (run) => bus.emit("run", run), 1000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  bus.on("run", (next) => {
    const requested = JSON.parse(next.toolTrace).find((call) => call.status === "requested");
    if (requested) coordinator.decideTool(next.id, requested.id, "approved");
  });
  const session = store.create();
  const run = coordinator.accept(session.id, "tool-request", "Read notes.txt");
  const completed = await new Promise((resolve) => bus.on("run", (next) => {
    if (next.id === run.id && !["queued", "running"].includes(next.status)) resolve(next);
  }));
  assert.equal(completed.status, "completed");
  assert.equal(completed.output, "The file says alpha.");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.name, "read_file");
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(requests[1].messages.at(-1).content, /alpha from workspace/);
  const trace = JSON.parse(store.getRun(run.id).toolTrace);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].status, "completed");
  assert.equal(trace[0].name, "read_file");
  assert.match(trace[0].result, /alpha from workspace/);
});

test("a rejected tool returns a model-visible error without executing the tool", { timeout: 5000 }, async (t) => {
  let executions = 0;
  const tools = { definitions: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    async execute() { executions++; return { content: "should not run", isError: false }; } };
  const runtime = { info: { kind: "demo", label: "approval test", model: null }, async *stream({ callTool }) {
    const result = await callTool({ id: "call_reject", name: "read_file", arguments: '{"path":"notes.txt"}' });
    yield result.isError ? "tool denied" : "tool allowed";
  } };
  const store = new SessionStore(":memory:"); const bus = new EventEmitter();
  const coordinator = new RunCoordinator(store, runtime, (run) => bus.emit("run", run), 1000, tools);
  t.after(async () => { await coordinator.shutdown(); store.close(); });
  const session = store.create();
  const run = coordinator.accept(session.id, "reject-request", "Read notes.txt");
  await new Promise((resolve) => bus.on("run", (next) => {
    if (next.id !== run.id) return;
    if (JSON.parse(next.toolTrace).some((call) => call.status === "requested")) resolve();
  }));
  coordinator.decideTool(run.id, "call_reject", "rejected");
  const completed = await new Promise((resolve) => bus.on("run", (next) => {
    if (next.id === run.id && next.status === "completed") resolve(next);
  }));
  assert.equal(completed.output, "tool denied");
  assert.equal(executions, 0);
  const trace = JSON.parse(store.getRun(run.id).toolTrace);
  assert.deepEqual(trace.map((call) => [call.status, call.result]), [["rejected", "用户拒绝了这次工具调用。"]]);
});

test("tool failures are returned to the model without reading outside the workspace", async (t) => {
  const { tools } = makeWorkspace(t);
  const result = await tools.execute("read_file", JSON.stringify({ path: "../secret.txt" }), signal);
  assert.equal(result.isError, true);
  assert.match(result.content, /工作区/);
});

test("plain tool-result mode labels file data and avoids unsupported tool-role follow-up", async (t) => {
  const { workspace, tools } = makeWorkspace(t);
  writeFileSync(join(workspace, "notes.txt"), "Cedar-731");
  const requests = [];
  const runtime = new ChatCompletionsRuntime(
    { baseUrl: "https://provider.example/v1", model: "test-model", apiKey: "test-key", toolResultMode: "plain" },
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) return response(sse({ tool_calls: [{ index: 0, id: "call_plain", type: "function",
        function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }] }) + sse({}, "tool_calls"));
      return response(sse({ content: "Cedar-731" }) + sse({}, "stop"));
    },
  );
  const output = [];
  for await (const chunk of runtime.stream({ messages: [{ role: "user", content: "Read notes.txt" }], signal,
    toolDefinitions: tools.definitions, callTool: ({ name, arguments: args }) => tools.execute(name, args, signal) })) {
    output.push(chunk);
  }
  assert.deepEqual(output, ["Cedar-731"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].tools, undefined);
  assert.deepEqual(requests[1].messages.map((message) => message.role), ["system", "user"]);
  assert.match(requests[1].messages[1].content, /Cedar-731/);
  assert.match(requests[1].messages[1].content, /仅作为数据/);
});

test("plain mode turns an entirely rejected tool round into an accurate runtime response", async () => {
  let requests = 0;
  const runtime = new ChatCompletionsRuntime(
    { baseUrl: "https://provider.example/v1", model: "test-model", apiKey: "test-key", toolResultMode: "plain" },
    async () => {
      requests++;
      return response(sse({ tool_calls: [{ index: 0, id: "call_denied", type: "function",
        function: { name: "search_workspace", arguments: '{"query":"Cedar-731"}' } }] }) + sse({}, "tool_calls"));
    },
  );
  const output = [];
  for await (const chunk of runtime.stream({ messages: [{ role: "user", content: "Search Cedar-731" }], signal,
    toolDefinitions: [{ type: "function" }], callTool: async () => ({ content: "用户拒绝了这次工具调用。", isError: true, denied: true }) })) {
    output.push(chunk);
  }
  assert.deepEqual(output, ["用户拒绝了 search_workspace 的调用；工具没有执行，因此我无法根据该工具的结果回答。"]);
  assert.equal(requests, 1);
});
