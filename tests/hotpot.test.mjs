import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ResearchHotpotTool } from "../dist/tools/research-hotpot.js";
import { scoreHotpot, answerF1 } from "../dist/hotpot-eval.js";
import { SkillRegistry } from "../dist/skills.js";
import { parseResearchCitations, validateResearchCitations } from "../dist/research-validation.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { SessionStore } from "../dist/session-store.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { ToolRegistry } from "../dist/tools/read-file.js";

const data = "data/hotpotqa/validation-sample.json";
const record = JSON.parse(readFileSync(data, "utf8"))[0];

test("Hotpot retrieval finds two linked hops without exposing gold labels", () => {
  const tool = new ResearchHotpotTool(data);
  const result = JSON.parse(tool.execute({ question: record.question }, new AbortController().signal));
  assert.equal(result.corpusId, record.id);
  assert.ok(result.retrieval.firstHop.includes("Kiss and Tell (1945 film)"));
  assert.ok(result.retrieval.secondHop.some((entry) => entry.title === "Shirley Temple" && entry.linkedFromFirstHop));
  assert.ok(result.evidence.some((entry) => entry.sentences.some((sentence) => sentence.citation === "Shirley Temple#1")));
  assert.doesNotMatch(JSON.stringify(result), /supporting_facts|"answer"/u);
});

test("an explicitly named series outranks its season aliases on the second hop", () => {
  const directory = mkdtempSync(join(tmpdir(), "hotpot-alias-"));
  const question = "How many episodes were in the original run of the HBO show that Kristin Davis played the character Charlotte York Goldenblatt?";
  const titles = ["Kristin Davis", "Charlotte York Goldenblatt", "Sex and the City (season 4)",
    "Sex and the City (season 5)", "Sex and the City (season 6)", "Sex and the City"];
  const sentences = ["Kristin Davis played Charlotte York Goldenblatt on Sex and the City.",
    "Charlotte York Goldenblatt is a character in Sex and the City.",
    "The HBO show starring Kristin Davis as Charlotte York Goldenblatt had a fourth season.",
    "The HBO show starring Kristin Davis as Charlotte York Goldenblatt had a fifth season.",
    "The HBO show starring Kristin Davis as Charlotte York Goldenblatt had a sixth season.",
    "The original HBO show ran for 94 episodes."];
  const path = join(directory, "data.json");
  try {
    writeFileSync(path, JSON.stringify([{ id: "alias", question, answer: "94", type: "bridge", level: "hard",
      supporting_facts: { title: [], sent_id: [] },
      context: { title: titles, sentences: sentences.map((sentence) => [sentence]) } }]));
    const result = JSON.parse(new ResearchHotpotTool(path).execute({ question }, new AbortController().signal));
    assert.ok(result.retrieval.secondHop.some((entry) => entry.title === "Sex and the City"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("answer and support scoring remain separate", () => {
  const score = scoreHotpot(record, "Chief of Protocol", ["Kiss and Tell (1945 film)#0", "Shirley Temple#1"]);
  assert.equal(score.answerEM, true);
  assert.equal(score.supportRecall, 2 / 3);
  assert.equal(score.supportEM, false);
  assert.equal(answerF1("Alan Turing", "Alan Mathison Turing"), 0.8);
});

test("research skill is explicit and ordinary chat does not activate it", () => {
  const skills = new SkillRegistry(process.cwd());
  assert.equal(skills.select(`/research ${record.question}`)?.id, "multi-hop-research");
  assert.equal(skills.select(record.question), undefined);
});

test("research completion requires real citations from both hops", () => {
  const evidence = new ResearchHotpotTool(data).execute({ question: record.question }, new AbortController().signal);
  assert.doesNotThrow(() => validateResearchCitations(
    "答案：Chief of Protocol\n[Kiss and Tell (1945 film)#0] [Shirley Temple#1]", evidence));
  assert.throws(() => validateResearchCitations("答案：United States ambassador [Shirley Temple#1]", evidence),
    { code: "RESEARCH_CITATION_INCOMPLETE" });
  assert.throws(() => validateResearchCitations("答案：Chief of Protocol [Kiss and Tell (1945 film)#0] [Shirley Temple#99]", evidence),
    { code: "RESEARCH_CITATION_INVALID" });
  assert.doesNotThrow(() => validateResearchCitations(
    "答案：Chief of Protocol [Kiss and Tell (1945 film)#0, Shirley Temple#1]", evidence));
  assert.throws(() => validateResearchCitations(
    "答案：Chief of Protocol [Kiss and Tell (1945 film)#0, Shirley Temple#99]", evidence),
    { code: "RESEARCH_CITATION_INVALID" });
  const available = new Set(["Kiss and Tell (1945 film)#0", "Shirley Temple#1", "Haleiwa, Hawaii#0"]);
  assert.deepEqual(parseResearchCitations("[Kiss and Tell (1945 film)#0, Shirley Temple#1] [Haleiwa, Hawaii#0]", available),
    { citations: ["Kiss and Tell (1945 film)#0", "Shirley Temple#1", "Haleiwa, Hawaii#0"], invalid: [] });
});

test("research run records Skill and worker evidence, then rejects an incomplete citation chain", { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "hotpot-run-"));
  const tools = new ToolRegistry(join(directory, "workspace"), data);
  const store = new SessionStore(":memory:");
  const bus = new EventEmitter();
  const runtime = { info: { kind: "demo", label: "fixture", model: null },
    async *stream({ callTool, skillInstruction, toolDefinitions }) {
      assert.match(skillInstruction, /short-span QA/u);
      assert.equal(toolDefinitions[0].function.name, "research_hotpot");
      await callTool({ id: "research_1", name: "research_hotpot", arguments: JSON.stringify({ question: record.question }) });
      yield "答案：ambassador [Shirley Temple#1]";
    } };
  const coordinator = new RunCoordinator(store, runtime, (run) => bus.emit("run", run), 2000,
    tools, 120_000, new SkillRegistry(process.cwd()));
  try {
    bus.on("run", (run) => {
      const requested = JSON.parse(run.toolTrace).find((call) => call.status === "requested");
      if (requested) coordinator.decideTool(run.id, requested.id, "approved");
    });
    const session = store.create();
    const accepted = coordinator.accept(session.id, "hotpot", `/research ${record.question}`);
    const terminal = await new Promise((resolve) => bus.on("run", (run) => {
      if (run.id === accepted.id && !["queued", "running"].includes(run.status)) resolve(run);
    }));
    assert.equal(terminal.status, "failed");
    assert.match(terminal.error, /缺少首跳/u);
    assert.equal(JSON.parse(terminal.contextTrace).skillId, "multi-hop-research");
    assert.equal(JSON.parse(terminal.toolTrace)[0].status, "completed");
  } finally { await coordinator.shutdown(); await tools.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
