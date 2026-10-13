import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { SessionStore } from "../dist/session-store.js";
import { createApplication } from "../dist/server.js";

function cli(port, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/mirror-cli.mjs", ...args], {
      env: { ...process.env, MIRROR_GATEWAY_URL: `ws://127.0.0.1:${port}/gateway` }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI and Web Gateway share sessions, runs, events, and reset semantics", { timeout: 12000 }, async (t) => {
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "demo", label: "CLI fixture", model: null }, async *stream() { yield "CLI answered"; } };
  const app = await createApplication(store, runtime);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); });
  const port = app.server.address().port;
  const created = await cli(port, "create");
  assert.equal(created.code, 0, created.stderr);
  const sessionId = created.stdout.trim();
  assert.ok(store.get(sessionId));
  const sent = await cli(port, "send", sessionId, "hello from CLI");
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /CLI answered/);
  const run = store.history(sessionId).runs[0];
  assert.equal(run.input, "hello from CLI");
  assert.equal(run.status, "completed");
  const inspected = await cli(port, "inspect", run.id);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).events.at(-1).type, "run.completed");
  const child = await cli(port, "new", sessionId);
  assert.equal(store.get(child.stdout.trim()).parentId, sessionId);
  const reset = await cli(port, "reset", child.stdout.trim());
  assert.match(reset.stdout, /第 1 代/);
  const listed = await cli(port, "sessions");
  assert.match(listed.stdout, /hello from CLI/);
});

test("non-interactive CLI leaves a tool pending until explicit decision", { timeout: 12000 }, async (t) => {
  const store = new SessionStore(":memory:");
  let executions = 0;
  const tools = { definitions: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    setAutomationReader() {},
    async execute() { executions++; return { content: "file text", isError: false }; }, async close() {} };
  const runtime = { info: { kind: "demo", label: "CLI approval", model: null }, async *stream({ callTool }) {
    const result = await callTool({ id: "cli-tool-1", name: "read_file", arguments: '{"path":"note.txt"}' });
    yield result.isError ? "denied" : "allowed";
  } };
  const app = await createApplication(store, runtime, 120_000, tools);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await app.close(); store.close(); });
  const port = app.server.address().port;
  const sessionId = (await cli(port, "create")).stdout.trim();
  const sent = await cli(port, "send", sessionId, "read note");
  assert.equal(sent.code, 2, sent.stderr);
  assert.match(sent.stderr, /工具待审批/);
  const run = store.history(sessionId).runs[0];
  assert.equal(JSON.parse(run.toolTrace)[0].status, "requested");
  assert.equal(executions, 0);
  const decided = await cli(port, "deny", run.id, "cli-tool-1");
  assert.equal(decided.code, 0, decided.stderr);
  for (let index = 0; index < 50 && store.getRun(run.id).status !== "completed"; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.getRun(run.id).output, "denied");
  assert.equal(executions, 0);
});
