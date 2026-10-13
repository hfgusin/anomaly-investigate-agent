import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationReportReader, failureReasons } from "../dist/evaluation-report.js";

test("paired evaluation reads exact questions only from matching dataset bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "mirror-eval-"));
  try {
    const reportPath = join(directory, "report.json");
    const datasetPath = join(directory, "dataset.json");
    const reader = new EvaluationReportReader(reportPath, datasetPath);
    assert.deepEqual(reader.overview(), { available: false, message: "还没有本机 Gateway 配对评测报告。" });
    const data = JSON.stringify([{ id: "q1", question: "Original question?", answer: "Answer",
      supporting_facts: { title: ["Book", "Author"], sent_id: [1, 2] } }]);
    const sha = createHash("sha256").update(data).digest("hex");
    writeFileSync(datasetPath, data);
    const run = { id: "q1", mode: "research2", status: "completed", error: null, durationMs: 1500,
      output: "Wrong [Book#1]", calls: [{ name: "open_passage", status: "completed", arguments: "{}", result: "{}" }],
      repair: null, answerExtracted: "Wrong", formatValid: true, citations: ["Book#1"], unsupportedCitations: [],
      score: { answerEM: false, supportEM: false, jointEM: false, answerF1: 0, supportF1: .5, jointF1: 0,
        gold: ["Book#1", "Author#2"], predicted: ["Book#1"] } };
    writeFileSync(reportPath, JSON.stringify({ scope: "test", model: "fixture", dataSha256: sha,
      startedAt: "today", finishedAt: "today", summary: { research2: { attempted: 1, completed: 1, jointEM: 0 } }, runs: [run] }));
    const overview = reader.overview();
    assert.equal(overview.datasetMatched, true);
    assert.equal(overview.cases[0].question, "Original question?");
    assert.deepEqual(overview.cases[0].runs[0].reasons, ["答案不匹配", "支持事实不匹配"]);
    const detail = reader.detail("q1");
    assert.equal(detail.goldAnswer, "Answer");
    assert.deepEqual(detail.goldSupport, ["Book#1", "Author#2"]);
    assert.equal(detail.runs[0].calls[0].name, "open_passage");
    writeFileSync(datasetPath, `${data} `);
    const mismatched = new EvaluationReportReader(reportPath, datasetPath).overview();
    assert.equal(mismatched.datasetMatched, false);
    assert.equal(mismatched.cases[0].question, null);
    assert.equal(mismatched.cases[0].goldAnswer, null);
    assert.deepEqual(failureReasons({ ...run, status: "failed", error: "研究回答引用不足" }), ["引用校验失败"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
