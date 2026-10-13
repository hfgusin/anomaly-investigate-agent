import { AppError, type ToolTrace } from "../session-store.js";
import { parseResearchCitations } from "../research-validation.js";
import type { ToolResult } from "./read-file.js";
import type { ResearchWorkerClient } from "./research-worker-client.js";

/** Request-scoped search/open limits and evidence ledger; gold labels never enter this class. */
export class ResearchSession {
  readonly definitions = [
    { type: "function" as const, function: { name: "search_passages",
      description: "Search the question's public candidate articles. Returns five titles and short excerpts, not full evidence.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search terms or the full question" } },
        required: ["query"], additionalProperties: false } } },
    { type: "function" as const, function: { name: "open_passage",
      description: "Open one title returned by search_passages and get numbered sentences that can be cited.",
      parameters: { type: "object", properties: { title: { type: "string", description: "Exact candidate title" } },
        required: ["title"], additionalProperties: false } } },
  ];
  private searches = 0;
  private opens = 0;
  private readonly candidates = new Set<string>();
  private readonly opened = new Map<string, Set<string>>();

  constructor(private readonly question: string, private readonly worker: ResearchWorkerClient) {}

  /** Rebuild the per-run budget and evidence ledger from durable tool results, without re-running tools. */
  restore(trace: ToolTrace[]): void {
    if (this.searches || this.opens || this.candidates.size || this.opened.size) {
      throw new AppError("RESEARCH_RESTORE_INVALID", "研究会话只能恢复一次。");
    }
    for (const call of trace) {
      if (call.status !== "completed" && call.status !== "failed") continue;
      if (call.name === "search_passages") {
        this.searches++;
        if (call.status !== "completed" || !call.result) continue;
        const result = JSON.parse(call.result) as { candidates?: Array<{ title: string }> };
        for (const candidate of result.candidates ?? []) this.candidates.add(candidate.title);
      } else if (call.name === "open_passage") {
        this.opens++;
        if (call.status !== "completed" || !call.result) continue;
        const result = JSON.parse(call.result) as { status?: string; title?: string; sentences?: Array<{ citation: string }> };
        if (result.status === "ok" && result.title) {
          this.opened.set(result.title, new Set((result.sentences ?? []).map((item) => item.citation)));
        }
      }
    }
  }

  async execute(name: string, rawArguments: string, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    try {
      if (rawArguments.length > 8192) throw new AppError("TOOL_INVALID_ARGS", "工具参数超过 8 KiB。");
      const args: unknown = JSON.parse(rawArguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new AppError("TOOL_INVALID_ARGS", "工具参数必须是对象。");
      if (name === "search_passages") {
        if (Object.keys(args).length !== 1 || typeof (args as { query?: unknown }).query !== "string") {
          throw new AppError("TOOL_INVALID_ARGS", "search_passages 只接受 query 字符串。");
        }
        const query = (args as { query: string }).query.trim();
        if (!query || query.length > 500) throw new AppError("TOOL_INVALID_QUERY", "搜索词必须为 1–500 字符。");
        if (++this.searches > 2) throw new AppError("TOOL_LIMIT", "本次研究最多搜索两次。");
        const content = await this.worker.execute({ question: this.question, query }, signal, undefined, "search_passages");
        const result = JSON.parse(content) as { candidates?: Array<{ title: string }> };
        for (const candidate of result.candidates ?? []) this.candidates.add(candidate.title);
        return { content: JSON.stringify({ ...result, remainingSearches: 2 - this.searches,
          remainingOpens: 4 - this.opens }), isError: false };
      }
      if (name === "open_passage") {
        if (Object.keys(args).length !== 1 || typeof (args as { title?: unknown }).title !== "string") {
          throw new AppError("TOOL_INVALID_ARGS", "open_passage 只接受 title 字符串。");
        }
        const title = (args as { title: string }).title;
        if (!this.candidates.has(title)) throw new AppError("TOOL_NOT_FOUND", "请先搜索并使用候选列表中的完整标题。");
        if (this.opened.has(title)) throw new AppError("TOOL_DUPLICATE", "这篇文章已经打开过。");
        if (++this.opens > 4) throw new AppError("TOOL_LIMIT", "本次研究最多打开四篇文章。");
        const content = await this.worker.execute({ question: this.question, title }, signal, undefined, "open_passage");
        const result = JSON.parse(content) as { status?: string; sentences?: Array<{ citation: string }> };
        if (result.status === "ok") this.opened.set(title, new Set((result.sentences ?? []).map((item) => item.citation)));
        return { content: JSON.stringify({ ...result, remainingSearches: 2 - this.searches,
          remainingOpens: 4 - this.opens }), isError: false };
      }
      throw new AppError("TOOL_NOT_FOUND", "未知研究工具。");
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { content: error instanceof AppError ? error.message : "研究工具执行失败。", isError: true };
    }
  }

  validate(output: string): void {
    const available = new Set([...this.opened.values()].flatMap((citations) => [...citations]));
    const { citations, invalid } = parseResearchCitations(output, available);
    if (invalid.length) throw new AppError("RESEARCH_CITATION_INVALID", "研究回答引用了未打开文章或不存在的句子。");
    if (/^证据不足/u.test(output.trim())) return;
    const citedArticles = [...this.opened].filter(([, sentences]) => citations.some((citation) => sentences.has(citation)));
    if (citedArticles.length < 2) throw new AppError("RESEARCH_CITATION_INCOMPLETE", "研究回答至少需要两篇已打开文章的句子出处。");
  }
}
