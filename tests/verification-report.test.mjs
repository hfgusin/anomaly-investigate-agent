import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseStatus, VerificationReportReader } from "../dist/verification-report.js";

const observation = (iteration, status = "passed") => ({ iteration, status, durationMs: 2, failureCode: null, failureReason: null });
test("verification distinguishes failure, environment blockage, skipped and incomplete repetitions", () => {
  for (const [observations, expected] of [
    [[observation(1), observation(2)], "passed"],
    [[observation(1), observation(2, "failed")], "failed"],
    [[observation(1), observation(2, "blocked")], "blocked"],
    [[observation(1), observation(2, "skipped")], "skipped"],
    [[observation(1)], "incomplete"],
  ]) assert.equal(caseStatus({ observations }, 2), expected);
});

test("verification report handles missing/invalid files and exposes exact evidence without fabricating traces", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mirror-report-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "report.json"); const reader = new VerificationReportReader(path);
  assert.equal(reader.overview().available, false);
  for (const value of ["{", "null", JSON.stringify({ schemaVersion: 1, repeats: 0, cases: [] }),
    JSON.stringify({ schemaVersion: 1, repeats: 1, cases: [null] })]) {
    writeFileSync(path, value); assert.throws(() => reader.overview(), { code: "VERIFICATION_INVALID" });
  }
  const evidence = { input: "fixture question", config: { maxConcurrent: 1 }, expected: "ok", actual: "ok", trace: [{ type: "run.completed" }] };
  const report = { schemaVersion: 1, repeats: 2, scope: "fixture", sourceSha256: "fixture-hash", startedAt: "fixture", finishedAt: "fixture", environment: { node: process.version }, cases: [{ id: "first", name: "fixture", file: "fixture.test.mjs", category: "baseline",
    observations: [{ ...observation(1), evidence }, observation(2)] }] };
  writeFileSync(path, JSON.stringify(report));
  assert.equal(reader.overview().summary.passed, 1);
  assert.equal(reader.overview().cases[0].evidenceCount, 1);
  assert.deepEqual(reader.detail("first").observations[0].evidence, evidence);
  assert.equal(reader.detail("first").observations[1].evidence, undefined);
  assert.throws(() => reader.detail("missing"), { code: "VERIFICATION_NOT_FOUND" });
  report.cases[0].observations[1].iteration = 1;
  writeFileSync(path, JSON.stringify(report)); assert.throws(() => reader.overview(), { code: "VERIFICATION_INVALID" });
});

test('report freshness changes when current source changes and is unknown without source', async t => {
  const { mkdirSync } = await import('node:fs');
  const { sourceHash } = await import('../dist/source-hash.js');
  const root = mkdtempSync(join(tmpdir(), 'mirror-freshness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['src', 'public', 'tests', 'scripts', 'skills', 'config', 'data/hotpotqa']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml', 'data/hotpotqa/validation-sample.json']) writeFileSync(join(root, file), '{}');
  const path = join(root, 'report.json');
  const report = { schemaVersion: 1, repeats: 1, scope: 'fixture', sourceSha256: sourceHash(root), startedAt: 'fixture', finishedAt: 'fixture', environment: { node: process.version }, cases: [] };
  writeFileSync(path, JSON.stringify(report));
  const reader = new VerificationReportReader(path, root);
  assert.equal(reader.overview().freshness, 'current');
  writeFileSync(join(root, 'src/new.ts'), 'changed');
  assert.equal(reader.overview().freshness, 'stale');
  assert.equal(new VerificationReportReader(path).overview().freshness, 'unknown');
  rmSync(join(root, 'src'), { recursive: true });
  assert.equal(reader.overview().freshness, 'unknown');
});
