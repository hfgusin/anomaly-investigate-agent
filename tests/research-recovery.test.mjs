import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { SessionStore } from "../dist/session-store.js";
import { ToolRegistry } from "../dist/tools/read-file.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { SkillRegistry } from "../dist/skills.js";

const data = "data/hotpotqa/validation-sample.json";
const record = JSON.parse(readFileSync(data, "utf8"))[0];

test("a recovered /research2 run reuses completed evidence and retries only the in-flight read-only search", { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-resume-"));
  const path = join(directory, "gateway.sqlite");
  let store = new SessionStore(path);
  let tools;
  let coordinator;
  try {
    const run = store.accept(store.create().id, "recover", `/research2 ${record.question}`);
    store.start(run.id);
    store.requestTool(run.id, "s1", "search_passages", JSON.stringify({ query: record.question }));
    store.decideTool(run.id, "s1", "approved");
    store.startTool(run.id, "s1");
    store.finishTool(run.id, "s1", JSON.stringify({ status: "ok", candidates: [{ title: "Kiss and Tell (1945 film)" }] }), false);
    store.requestTool(run.id, "o1", "open_passage", JSON.stringify({ title: "Kiss and Tell (1945 film)" }));
    store.decideTool(run.id, "o1", "approved");
    store.startTool(run.id, "o1");
    store.finishTool(run.id, "o1", JSON.stringify({ status: "ok", title: "Kiss and Tell (1945 film)",
      sentences: [{ citation: "Kiss and Tell (1945 film)#0", text: "The film starred Shirley Temple." }] }), false);
    store.appendOutput(run.id, "partial output before crash");
    store.requestTool(run.id, "s2", "search_passages", JSON.stringify({ query: "Shirley Temple" }));
    store.decideTool(run.id, "s2", "approved");
    store.startTool(run.id, "s2");
    store.close();
    store = new SessionStore(path);
    assert.equal(store.requeueResearchRuns(), 1);
    assert.equal(store.recoverInterrupted(), 0);
    assert.equal(store.recoveryDrafts(run.id)[0].partialOutput, "partial output before crash");
    assert.equal(store.getRun(run.id).output, "");
    assert.equal(JSON.parse(store.getRun(run.id).toolTrace)[2].status, "approved");

    tools = new ToolRegistry(join(directory, "workspace"), data);
    const bus = new EventEmitter();
    const runtime = { info: { kind: "demo", label: "resume fixture", model: null },
      async *stream({ messages, callTool, toolResultMode }) {
        assert.equal(toolResultMode, "standard");
        const prompt = messages.at(-1).content;
        assert.match(prompt, /Kiss and Tell \(1945 film\)/u);
        assert.match(prompt, /Shirley Temple/u);
        const result = await callTool({ id: "o2", name: "open_passage", arguments: JSON.stringify({ title: "Shirley Temple" }) });
        assert.equal(result.isError, false);
        yield "答案：Chief of Protocol\n[Kiss and Tell (1945 film)#0] [Shirley Temple#1]";
      } };
    coordinator = new RunCoordinator(store, runtime, (next) => bus.emit("run", next), 5000,
      tools, 120_000, new SkillRegistry(process.cwd()));
    bus.on("run", (next) => {
      for (const call of JSON.parse(next.toolTrace).filter((item) => item.status === "requested")) {
        coordinator.decideTool(next.id, call.id, "approved");
      }
    });
    const terminal = new Promise((resolve) => bus.on("run", (next) => {
      if (next.id === run.id && !["queued", "running"].includes(next.status)) resolve(next);
    }));
    assert.equal(coordinator.resumeQueuedResearchRuns(), 1);
    const finished = await terminal;
    assert.equal(finished.status, "completed");
    assert.deepEqual(JSON.parse(finished.toolTrace).map((call) => call.id), ["s1", "o1", "s2", "o2"]);
    assert.deepEqual(JSON.parse(finished.toolTrace).map((call) => call.status),
      ["completed", "completed", "completed", "completed"]);
    assert.equal(JSON.parse(finished.checkpoint).phase, "completed");
    assert.ok(store.eventsForRun(run.id).some((event) => event.type === "run.requeued"));
  } finally {
    await coordinator?.shutdown(); await tools?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery leaves an undecided tool waiting for the user's decision", { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-approval-resume-"));
  const path = join(directory, "gateway.sqlite");
  let store = new SessionStore(path);
  let tools;
  let coordinator;
  try {
    const run = store.accept(store.create().id, "approval", `/research2 ${record.question}`);
    store.start(run.id);
    store.requestTool(run.id, "pending_search", "search_passages", JSON.stringify({ query: record.question }));
    store.close();
    store = new SessionStore(path);
    assert.equal(store.requeueResearchRuns(), 1);
    tools = new ToolRegistry(join(directory, "workspace"), data);
    const bus = new EventEmitter();
    const runtime = { info: { kind: "demo", label: "approval fixture", model: null },
      async *stream({ messages }) {
        assert.match(messages.at(-1).content, /用户拒绝/u);
        yield "证据不足：用户拒绝了检索。";
      } };
    coordinator = new RunCoordinator(store, runtime, (next) => bus.emit("run", next), 5000,
      tools, 120_000, new SkillRegistry(process.cwd()));
    const waiting = new Promise((resolve) => bus.on("run", (next) => {
      if (next.id === run.id && next.status === "running" &&
        JSON.parse(next.toolTrace)[0].status === "requested") resolve();
    }));
    const terminal = new Promise((resolve) => bus.on("run", (next) => {
      if (next.id === run.id && !["queued", "running"].includes(next.status)) resolve(next);
    }));
    coordinator.resumeQueuedResearchRuns();
    await waiting;
    assert.equal(JSON.parse(store.getRun(run.id).toolTrace)[0].result, null);
    coordinator.decideTool(run.id, "pending_search", "rejected");
    const finished = await terminal;
    assert.equal(finished.status, "completed");
    assert.equal(JSON.parse(finished.toolTrace)[0].status, "rejected");
    assert.equal(JSON.parse(finished.checkpoint).phase, "completed");
  } finally {
    await coordinator?.shutdown(); await tools?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("SIGKILL at three tool boundaries retries only uncommitted read-only work", { timeout: 20000 }, async () => {
  for (const stage of ["started", "returned", "committed"]) {
    const directory = mkdtempSync(join(tmpdir(), `research-kill-${stage}-`));
    const path = join(directory, "gateway.sqlite");
    const child = spawn(process.execPath, ["tests/fixtures/research-crash-process.mjs", path, stage],
      { stdio: ["ignore", "pipe", "pipe"] });
    let store;
    let tools;
    let coordinator;
    try {
      const lines = createInterface({ input: child.stdout });
      let ready;
      for await (const line of lines) { ready = JSON.parse(line); lines.close(); break; }
      if (!ready) throw new Error(`crash fixture did not start at ${stage}`);
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      store = new SessionStore(path);
      assert.equal(store.requeueResearchRuns(), 1);
      tools = new ToolRegistry(join(directory, "workspace"), data);
      const bus = new EventEmitter();
      const runtime = { info: { kind: "demo", label: "kill fixture", model: null },
        async *stream({ messages }) {
          assert.match(messages.at(-1).content, /Kiss and Tell/u);
          yield "证据不足：当前只完成首跳。";
        } };
      coordinator = new RunCoordinator(store, runtime, (next) => bus.emit("run", next), 5000,
        tools, 120_000, new SkillRegistry(process.cwd()));
      const terminal = new Promise((resolve) => bus.on("run", (next) => {
        if (next.id === ready.runId && !["queued", "running"].includes(next.status)) resolve(next);
      }));
      coordinator.resumeQueuedResearchRuns();
      const finished = await terminal;
      assert.equal(finished.status, "completed", stage);
      const call = JSON.parse(finished.toolTrace)[0];
      assert.equal(call.status, "completed", stage);
      assert.equal(store.eventsForRun(ready.runId).filter((event) => event.type === "tool.completed").length, 1, stage);
      if (ready.result) {
        assert.deepEqual(JSON.parse(call.result).candidates, JSON.parse(ready.result).candidates, stage);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
      await coordinator?.shutdown(); await tools?.close(); store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("graceful Gateway shutdown leaves an active /research2 approval recoverable", { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-graceful-"));
  const path = join(directory, "gateway.sqlite");
  let store = new SessionStore(path);
  const tools = new ToolRegistry(join(directory, "workspace"), data);
  const bus = new EventEmitter();
  const runtime = { info: { kind: "demo", label: "shutdown fixture", model: null },
    async *stream({ callTool }) {
      await callTool({ id: "s1", name: "search_passages", arguments: JSON.stringify({ query: record.question }) });
      yield "unused";
    } };
  const coordinator = new RunCoordinator(store, runtime, (next) => bus.emit("run", next), 5000,
    tools, 120_000, new SkillRegistry(process.cwd()));
  try {
    const run = coordinator.accept(store.create().id, "graceful", `/research2 ${record.question}`);
    await new Promise((resolve) => bus.on("run", (next) => {
      if (next.id === run.id && JSON.parse(next.toolTrace).some((call) => call.status === "requested")) resolve();
    }));
    await coordinator.shutdown();
    assert.equal(store.getRun(run.id).status, "running");
    assert.equal(store.eventsForRun(run.id).at(-1).type, "run.suspended");
    store.close();
    store = new SessionStore(path);
    assert.equal(store.requeueResearchRuns(), 1);
    assert.equal(JSON.parse(store.getRun(run.id).toolTrace)[0].status, "requested");
  } finally {
    await coordinator.shutdown(); await tools.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
