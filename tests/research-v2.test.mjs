import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ResearchWorkerClient } from "../dist/tools/research-worker-client.js";
import { ResearchSession } from "../dist/tools/research-session.js";
import { ToolRegistry } from "../dist/tools/read-file.js";
import { SessionStore } from "../dist/session-store.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { SkillRegistry } from "../dist/skills.js";

const data = "data/hotpotqa/validation-sample.json";
const record = JSON.parse(readFileSync(data, "utf8"))[0];
const signal = new AbortController().signal;

test("v2 search only exposes candidates, open only accepts searched titles, and budgets are per run", async () => {
  const worker = new ResearchWorkerClient(data);
  const session = new ResearchSession(record.question, worker);
  try {
    const searched = await session.execute("search_passages", JSON.stringify({ query: record.question }), signal);
    assert.equal(searched.isError, false);
    const results = JSON.parse(searched.content);
    assert.equal(results.status, "ok");
    assert.ok(results.candidates.length <= 5);
    assert.equal(results.remainingSearches, 1);
    assert.equal(results.remainingOpens, 4);
    assert.doesNotMatch(searched.content, /supporting_facts|"answer"/u);
    const unseen = await session.execute("open_passage", JSON.stringify({ title: "Shirley Temple" }), signal);
    assert.equal(unseen.isError, true);
    assert.match(unseen.content, /先搜索/u);
    const secondSearch = await session.execute("search_passages", JSON.stringify({ query: "Shirley Temple" }), signal);
    assert.equal(secondSearch.isError, false);
    const title = JSON.parse(secondSearch.content).candidates[0].title;
    const opened = await session.execute("open_passage", JSON.stringify({ title }), signal);
    assert.equal(opened.isError, false);
    assert.ok(JSON.parse(opened.content).sentences[0].citation.startsWith(`${title}#`));
    assert.equal(JSON.parse(opened.content).remainingOpens, 3);
    assert.equal((await session.execute("open_passage", JSON.stringify({ title }), signal)).isError, true);
    assert.equal((await session.execute("search_passages", JSON.stringify({ query: "extra" }), signal)).isError, true);
  } finally { await worker.close(); }
});

test("rare query phrase finds the event even when venue words dominate other titles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-rank-"));
  const question = "What mixed martial arts event took place at Trump Plaza Hotel and Casino?";
  const titles = ["Trump Plaza Hotel and Casino", "UFC 50", "Trump Entertainment Resorts",
    "Atlantic Casino One", "Atlantic Casino Two", "Atlantic Casino Three"];
  const sentences = ["Trump Plaza is a closed hotel and casino owned by Trump Entertainment Resorts.",
    "UFC 50 was a mixed martial arts event held at Trump Plaza in Atlantic City.",
    "Trump Entertainment Resorts operated the Trump Plaza hotel and casino.",
    "Atlantic City hotel and casino near Trump Plaza.", "Atlantic City hotel and casino near Trump Plaza.",
    "Atlantic City hotel and casino near Trump Plaza."];
  const path = join(directory, "data.json");
  try {
    writeFileSync(path, JSON.stringify([{ id: "rank", question, answer: "UFC 50", type: "bridge", level: "hard",
      supporting_facts: { title: [], sent_id: [] },
      context: { title: titles, sentences: sentences.map((sentence) => [sentence]) } }]));
    const worker = new ResearchWorkerClient(path);
    try {
      const session = new ResearchSession(question, worker);
      const result = JSON.parse((await session.execute("search_passages", JSON.stringify({ query: question }), signal)).content);
      assert.ok(result.candidates.some((candidate) => candidate.title === "UFC 50"));
    } finally { await worker.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("v2 Gateway run records separately approved search and open calls", { timeout: 8000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-v2-"));
  const tools = new ToolRegistry(join(directory, "workspace"), data);
  const store = new SessionStore(":memory:");
  const bus = new EventEmitter();
  const runtime = { info: { kind: "demo", label: "fixture", model: null },
    async *stream({ callTool, toolDefinitions, toolResultMode }) {
      assert.equal(toolResultMode, "standard");
      assert.deepEqual(toolDefinitions.map((entry) => entry.function.name), ["search_passages", "open_passage"]);
      const invoke = async (id, name, args) => {
        const response = await callTool({ id, name, arguments: JSON.stringify(args) });
        assert.equal(response.isError, false);
        return JSON.parse(response.content);
      };
      const first = await invoke("s1", "search_passages", { query: record.question });
      assert.ok(first.candidates.some((candidate) => candidate.title === "Kiss and Tell (1945 film)"));
      await invoke("o1", "open_passage", { title: "Kiss and Tell (1945 film)" });
      await invoke("s2", "search_passages", { query: "Shirley Temple" });
      await invoke("o2", "open_passage", { title: "Shirley Temple" });
      yield "答案：Chief of Protocol\n[Kiss and Tell (1945 film)#0] [Shirley Temple#1]";
    } };
  const coordinator = new RunCoordinator(store, runtime, (run) => bus.emit("run", run), 5000,
    tools, 120_000, new SkillRegistry(process.cwd()));
  try {
    bus.on("run", (run) => {
      for (const call of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) {
        coordinator.decideTool(run.id, call.id, "approved");
      }
    });
    const accepted = coordinator.accept(store.create().id, "v2", `/research2 ${record.question}`);
    const terminal = await new Promise((resolve) => bus.on("run", (run) => {
      if (run.id === accepted.id && !["queued", "running"].includes(run.status)) resolve(run);
    }));
    assert.equal(terminal.status, "completed");
    assert.deepEqual(JSON.parse(terminal.toolTrace).map((call) => call.name),
      ["search_passages", "open_passage", "search_passages", "open_passage"]);
    assert.equal(JSON.parse(terminal.contextTrace).skillId, "multi-hop-research-v2");
  } finally { await coordinator.shutdown(); await tools.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("v2 repairs a missing second citation once and records both drafts", { timeout: 8000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "research-repair-"));
  const tools = new ToolRegistry(join(directory, "workspace"), data);
  const store = new SessionStore(":memory:");
  const bus = new EventEmitter();
  let pass = 0;
  const runtime = { info: { kind: "demo", label: "repair fixture", model: null },
    async *stream({ callTool, messages, toolResultMode }) {
      assert.equal(toolResultMode, "standard");
      pass++;
      const invoke = async (id, name, args) => {
        const result = await callTool({ id, name, arguments: JSON.stringify(args) });
        assert.equal(result.isError, false);
      };
      if (pass === 1) {
        await invoke("s1", "search_passages", { query: record.question });
        await invoke("o1", "open_passage", { title: "Kiss and Tell (1945 film)" });
        await invoke("s2", "search_passages", { query: "Shirley Temple" });
        yield "答案：Chief of Protocol\n[Kiss and Tell (1945 film)#0]";
      } else {
        assert.match(messages[0].content, /至少需要两篇/u);
        await invoke("o2", "open_passage", { title: "Shirley Temple" });
        yield "答案：Chief of Protocol\n[Kiss and Tell (1945 film)#0] [Shirley Temple#1]";
      }
    } };
  const coordinator = new RunCoordinator(store, runtime, (run) => bus.emit("run", run), 5000,
    tools, 120_000, new SkillRegistry(process.cwd()));
  try {
    bus.on("run", (run) => {
      for (const call of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) {
        coordinator.decideTool(run.id, call.id, "approved");
      }
    });
    const accepted = coordinator.accept(store.create().id, "repair", `/research2 ${record.question}`);
    const terminal = await new Promise((resolve) => bus.on("run", (run) => {
      if (run.id === accepted.id && !["queued", "running"].includes(run.status)) resolve(run);
    }));
    assert.equal(terminal.status, "completed");
    assert.equal(pass, 2);
    assert.match(terminal.output, /Shirley Temple#1/u);
    const repair = JSON.parse(terminal.contextTrace).researchRepair;
    assert.equal(repair.succeeded, true);
    assert.equal(repair.initialOutput, "答案：Chief of Protocol\n[Kiss and Tell (1945 film)#0]");
    assert.equal(JSON.parse(terminal.toolTrace).length, 4);
  } finally { await coordinator.shutdown(); await tools.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
