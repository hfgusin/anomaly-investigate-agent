import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { AppError } from "./session-store.js";

type Score = { answerEM: boolean; supportEM: boolean; jointEM: boolean; answerF1: number; supportF1: number; jointF1: number;
  gold: string[]; predicted: string[] };
type EvalCall = { name: string; status: string; arguments: string; result: string | null };
type EvalRun = { id: string; mode: "research" | "research2"; status: string; error: string | null;
  durationMs: number; output: string; calls: EvalCall[]; repair: Record<string, unknown> | null;
  answerExtracted: string; formatValid: boolean; citations: string[]; unsupportedCitations: string[]; score: Score };
type Report = { scope: string; model: string; dataSha256: string; startedAt: string; finishedAt?: string;
  runs: EvalRun[]; summary: Record<string, Record<string, number>> };
type HotpotRecord = { id: string; question: string; answer: string; supporting_facts: { title: string[]; sent_id: number[] } };

export function failureReasons(run: EvalRun): string[] {
  const reasons: string[] = [];
  if (run.status !== "completed") reasons.push(/引用|出处/u.test(run.error ?? "") ? "引用校验失败" : "运行失败");
  if (run.calls.some((call) => call.status === "failed")) reasons.push("工具调用失败");
  if (run.status === "completed" && !run.formatValid) reasons.push("回答格式无效");
  if (run.status === "completed" && !run.score.answerEM) reasons.push("答案不匹配");
  if (run.status === "completed" && !run.score.supportEM) reasons.push("支持事实不匹配");
  if (run.unsupportedCitations.length) reasons.push("引用不在工具证据中");
  return reasons.length ? reasons : ["联合精确匹配通过"];
}

export class EvaluationReportReader {
  private reportCache: { modified: number; value: Report } | null = null;
  private dataCache: { sha256: string; records: Map<string, HotpotRecord> } | null = null;

  constructor(private readonly reportPath: string, private readonly datasetPath: string) {}

  private report(): Report | null {
    let modified: number;
    try { modified = statSync(this.reportPath).mtimeMs; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (this.reportCache?.modified === modified) return this.reportCache.value;
    let value: Report;
    try { value = JSON.parse(readFileSync(this.reportPath, "utf8")) as Report; }
    catch { throw new AppError("EVALUATION_INVALID", "评测报告不是合法 JSON。"); }
    if (!Array.isArray(value.runs) || typeof value.dataSha256 !== "string" || !value.summary || !value.model ||
      value.runs.some((run) => !run.id || !["research", "research2"].includes(run.mode) || !run.score || !Array.isArray(run.calls))) {
      throw new AppError("EVALUATION_INVALID", "评测报告缺少必要字段。");
    }
    this.reportCache = { modified, value };
    return value;
  }

  private records(expectedSha256: string): Map<string, HotpotRecord> | null {
    if (this.dataCache?.sha256 === expectedSha256) return this.dataCache.records;
    let bytes: Buffer;
    try { bytes = readFileSync(this.datasetPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) return null;
    let records: HotpotRecord[];
    try { records = JSON.parse(bytes.toString("utf8")) as HotpotRecord[]; }
    catch { throw new AppError("EVALUATION_INVALID", "评测数据集不是合法 JSON。"); }
    if (!Array.isArray(records)) throw new AppError("EVALUATION_INVALID", "评测数据集格式错误。");
    this.dataCache = { sha256, records: new Map(records.map((record) => [record.id, record])) };
    return this.dataCache.records;
  }

  overview() {
    const report = this.report();
    if (!report) return { available: false, message: "还没有本机 Gateway 配对评测报告。" };
    const records = this.records(report.dataSha256);
    const ids = [...new Set(report.runs.map((run) => run.id))];
    return { available: true, model: report.model, startedAt: report.startedAt, finishedAt: report.finishedAt ?? null,
      dataSha256: report.dataSha256, datasetMatched: Boolean(records), summary: report.summary,
      cases: ids.map((id) => ({ id, question: records?.get(id)?.question ?? null,
        goldAnswer: records?.get(id)?.answer ?? null,
        runs: report.runs.filter((run) => run.id === id).map((run) => ({ mode: run.mode, status: run.status,
          durationMs: run.durationMs, answerExtracted: run.answerExtracted, score: run.score,
          reasons: failureReasons(run), toolErrors: run.calls.filter((call) => call.status === "failed").length })) })) };
  }

  detail(id: string) {
    const report = this.report();
    if (!report) throw new AppError("EVALUATION_NOT_FOUND", "还没有本机评测报告。");
    const runs = report.runs.filter((run) => run.id === id);
    if (!runs.length) throw new AppError("EVALUATION_NOT_FOUND", "评测题目不存在。");
    const record = this.records(report.dataSha256)?.get(id);
    return { id, question: record?.question ?? null, goldAnswer: record?.answer ?? null,
      goldSupport: record ? record.supporting_facts.title.map((title, index) => `${title}#${record.supporting_facts.sent_id[index]}`) : null,
      runs: runs.map((run) => ({ ...run, reasons: failureReasons(run) })) };
  }
}
