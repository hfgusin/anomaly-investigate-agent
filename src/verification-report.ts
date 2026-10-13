import { sourceHash } from "./source-hash.js";
import { readFileSync, statSync } from "node:fs";
import { AppError } from "./session-store.js";

export type Evidence = { input: unknown; config: unknown; expected: unknown; actual: unknown; trace: unknown[] };
export type Observation = { iteration: number; status: "passed" | "failed" | "blocked" | "skipped";
  durationMs: number; failureCode: string | null; failureReason: string | null; evidence?: Evidence };
export type VerificationCase = { id: string; name: string; file: string; category: string; observations: Observation[] };
export type VerificationReport = { schemaVersion: 1; scope: string; startedAt: string; finishedAt: string; repeats: number;
  sourceSha256: string; environment: { node: string; platform: string; arch: string }; configuration: unknown;
  cases: VerificationCase[] };

export function caseStatus(item: VerificationCase, repeats: number) {
  if (item.observations.length !== repeats) return "incomplete";
  if (item.observations.some((run) => run.status === "failed")) return "failed";
  if (item.observations.some((run) => run.status === "blocked")) return "blocked";
  if (item.observations.some((run) => run.status === "skipped")) return "skipped";
  return "passed";
}

export class VerificationReportReader {
  constructor(private readonly path: string, private readonly root?: string) {}
  private read(): VerificationReport | null {
    let raw: string;
    try {
      if (statSync(this.path).size > 10_000_000) throw new AppError("VERIFICATION_INVALID", "验收报告超过大小上限。");
      raw = readFileSync(this.path, "utf8");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (raw.length > 10_000_000) throw new AppError("VERIFICATION_INVALID", "验收报告超过大小上限。");
    let report: VerificationReport;
    try { report = JSON.parse(raw); } catch { throw new AppError("VERIFICATION_INVALID", "验收报告不是合法 JSON。"); }
    if (!report || report.schemaVersion !== 1 || !Array.isArray(report.cases) || !Number.isInteger(report.repeats) || report.repeats < 1 || report.repeats > 10 || new Set(report.cases.map((item) => item?.id)).size !== report.cases.length ||
      typeof report.scope !== "string" || typeof report.sourceSha256 !== "string" || typeof report.startedAt !== "string" || typeof report.finishedAt !== "string" || !report.environment || typeof report.environment.node !== "string" ||
      report.cases.some((item) => !item || typeof item.id !== "string" || !item.id || typeof item.file !== "string" || typeof item.category !== "string" || typeof item.name !== "string" || !Array.isArray(item.observations) ||
        item.observations.some((run) => !run || !Number.isInteger(run.iteration) || run.iteration < 1 || run.iteration > report.repeats || !Number.isFinite(run.durationMs) || run.durationMs < 0 || !["passed", "failed", "blocked", "skipped"].includes(run.status) || run.evidence !== undefined && (!run.evidence || !Array.isArray(run.evidence.trace) || !["input", "config", "expected", "actual"].every((key) => Object.hasOwn(run.evidence!, key)))) || new Set(item.observations.map((run) => run.iteration)).size !== item.observations.length)) {
      throw new AppError("VERIFICATION_INVALID", "验收报告字段不完整。");
    }
    return report;
  }
  overview() {
    const report = this.read();
    if (!report) return { available: false, message: "尚无验收报告。请在终端运行 pnpm verify --repeat 2。" };
    const cases = report.cases.map((item) => ({ id: item.id, name: item.name, file: item.file, category: item.category,
      status: caseStatus(item, report.repeats), evidenceCount: item.observations.filter((run) => run.evidence).length,
      observedRepeats: item.observations.length, durationsMs: item.observations.map((run) => run.durationMs),
      failures: item.observations.filter((run) => run.status !== "passed").map((run) => ({ iteration: run.iteration,
        code: run.failureCode, reason: run.failureReason ?? "未执行或跳过" })) }));
    let freshness: "current" | "stale" | "unknown" = "unknown";
    let currentSourceSha256: string | null = null;
    if (this.root) {
      try { currentSourceSha256 = sourceHash(this.root); freshness = currentSourceSha256 === report.sourceSha256 ? "current" : "stale"; }
      catch { /* Missing source files cannot establish freshness. */ }
    }
    return { available: true, ...report, freshness, currentSourceSha256, cases, summary: { total: cases.length,
      passed: cases.filter((item) => item.status === "passed").length,
      failed: cases.filter((item) => item.status === "failed").length,
      blocked: cases.filter((item) => item.status === "blocked").length,
      skipped: cases.filter((item) => ["skipped", "incomplete"].includes(item.status)).length } };
  }
  detail(id: string) {
    const report = this.read();
    const item = report?.cases.find((entry) => entry.id === id);
    if (!item || !report) throw new AppError("VERIFICATION_NOT_FOUND", "验收场景不存在。");
    return { ...item, status: caseStatus(item, report.repeats) };
  }
}
