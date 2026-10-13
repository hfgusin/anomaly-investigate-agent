import { readFileSync } from "node:fs";
import { AppError } from "../session-store.js";

export type HotpotRecord = {
  id: string; question: string; answer: string; type: string; level: string;
  supporting_facts: { title: string[]; sent_id: number[] };
  context: { title: string[]; sentences: string[][] };
};
type Passage = { title: string; sentences: string[] };
const STOP = new Set("a an and are as at be by did do does for from has have how in into is it its of on or the their to was were what when where which who whose with woman film held".split(" "));
const tokens = (value: string): string[] => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter((word) => word.length > 2 && !STOP.has(word));
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const titleAlias = (title: string): string => title.replace(/\s*\([^)]*\)$/u, "").split(",")[0]!.trim().toLowerCase();

export function validateHotpotRecords(value: unknown): HotpotRecord[] {
  if (!Array.isArray(value) || !value.length) throw new AppError("INVALID_CORPUS", "HotpotQA 数据必须是非空数组。");
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.question !== "string" ||
      typeof item.answer !== "string" || !Array.isArray(item.context?.title) || !Array.isArray(item.context?.sentences) ||
      item.context.title.length !== item.context.sentences.length ||
      !item.context.title.every((title: unknown) => typeof title === "string") ||
      !item.context.sentences.every((sentences: unknown) => Array.isArray(sentences) &&
        sentences.every((sentence: unknown) => typeof sentence === "string")) ||
      !Array.isArray(item.supporting_facts?.title) || !Array.isArray(item.supporting_facts?.sent_id) ||
      item.supporting_facts.title.length !== item.supporting_facts.sent_id.length) {
      throw new AppError("INVALID_CORPUS", "HotpotQA 记录缺少必要字段或候选资料格式错误。");
    }
  }
  return value as HotpotRecord[];
}

/** Bounded two-hop retrieval over the per-question distractor passages. Gold labels are never exposed. */
export class ResearchHotpotTool {
  readonly name = "research_hotpot";
  readonly definition = {
    type: "function" as const,
    function: {
      name: "research_hotpot",
      description: "Retrieve two hops of sentence-numbered evidence from the public HotpotQA distractor corpus for a multi-hop question. No gold answer or support labels are returned.",
      parameters: { type: "object", properties: { question: { type: "string", description: "The user's full multi-hop question" } },
        required: ["question"], additionalProperties: false },
    },
  };
  private readonly records: HotpotRecord[];
  private readonly recordsByQuestion: Map<string, HotpotRecord>;

  constructor(datasetPath: string) {
    this.records = validateHotpotRecords(JSON.parse(readFileSync(datasetPath, "utf8")));
    this.recordsByQuestion = new Map(this.records.map((record) => [record.question.trim().toLowerCase(), record]));
  }

  execute(args: unknown, signal: AbortSignal): string {
    signal.throwIfAborted();
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 ||
      typeof (args as { question?: unknown }).question !== "string") {
      throw new AppError("TOOL_INVALID_ARGS", "research_hotpot 只接受 question 字符串参数。");
    }
    const question = (args as { question: string }).question.trim();
    if (!question || question.length > 500) throw new AppError("TOOL_INVALID_QUERY", "研究问题必须是 1–500 个字符。");
    const record = this.recordsByQuestion.get(question.toLowerCase());
    if (!record) return JSON.stringify({ question, status: "not_in_corpus", evidence: [],
      note: "当前只支持已载入 HotpotQA distractor 数据中的原题；没有可引用证据。" });
    const passages: Passage[] = record.context.title.map((title, index) => ({ title,
      sentences: record.context.sentences[index]! }));
    const terms = unique(tokens(question));
    const score = (passage: Passage): number => {
      const title = passage.title.toLowerCase();
      const body = passage.sentences.join(" ").toLowerCase();
      const alias = titleAlias(passage.title);
      const exactEntity = alias.length >= 5 && question.toLowerCase().includes(alias) ? 12 : 0;
      return exactEntity + terms.reduce((total, term) => total + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
    };
    const ranked = passages.map((passage, index) => ({ passage, index, score: score(passage) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const first = ranked.slice(0, 3);
    const firstText = first.map((entry) => entry.passage.sentences.join(" ").toLowerCase()).join(" ");
    const second = ranked.filter((entry) => !first.includes(entry))
      .map((entry) => ({ ...entry, bridge: firstText.includes(entry.passage.title.toLowerCase()) ? 2 :
        titleAlias(entry.passage.title).length >= 5 && firstText.includes(titleAlias(entry.passage.title)) ? 1 : 0 }))
      .sort((a, b) => b.bridge - a.bridge || b.score - a.score || a.index - b.index).slice(0, 2);
    const selected = [...first.map((entry) => ({ ...entry, hop: 1 })),
      ...second.map((entry) => ({ ...entry, hop: 2 }))];
    return JSON.stringify({ question, status: "ok", corpusId: record.id, retrieval: {
      firstHop: first.map((entry) => entry.passage.title),
      secondHop: second.map((entry) => ({ title: entry.passage.title, linkedFromFirstHop: Boolean(entry.bridge) })),
    }, evidence: selected.map((entry) => ({ title: entry.passage.title, hop: entry.hop,
      sentences: entry.passage.sentences.map((text, sentId) => ({ sentId, text: text.trim(), citation: `${entry.passage.title}#${sentId}` })) })) });
  }

  search(question: string, query: string, signal: AbortSignal): string {
    signal.throwIfAborted();
    const record = this.recordsByQuestion.get(question.trim().toLowerCase());
    if (!record) return JSON.stringify({ status: "not_in_corpus", candidates: [] });
    const terms = unique(tokens(query));
    if (!terms.length || query.length > 500) throw new AppError("TOOL_INVALID_QUERY", "搜索词必须包含有效词，最多 500 字符。");
    const passages: Passage[] = record.context.title.map((title, index) => ({ title,
      sentences: record.context.sentences[index]! }));
    const bodies = passages.map((passage) => `${passage.title} ${passage.sentences.join(" ")}`.toLowerCase());
    const idf = (term: string): number => 1 + Math.log((passages.length + 1) /
      (1 + bodies.filter((body) => body.includes(term)).length));
    const phrases = terms.slice(0, -1).map((term, index) => `${term} ${terms[index + 1]}`);
    const ranked = passages.map((passage, index) => {
      const title = passage.title.toLowerCase();
      const body = passage.sentences.join(" ").toLowerCase();
      const score = terms.reduce((sum, term) => sum + idf(term) *
        ((title.includes(term) ? 2 : 0) + (body.includes(term) ? 1 : 0)), 0) +
        phrases.reduce((sum, phrase) => sum + (body.includes(phrase) ? 2 * idf(phrase) : 0), 0);
      const excerpt = passage.sentences.map((text, sentenceIndex) => ({ text, sentenceIndex,
        score: terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0), 0) }))
        .sort((a, b) => b.score - a.score || a.sentenceIndex - b.sentenceIndex)[0]?.text.trim().slice(0, 300) ?? "";
      return { title: passage.title, excerpt, score, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    return JSON.stringify({ status: "ok", query, candidates: ranked.slice(0, 5)
      .map(({ title, excerpt }) => ({ title, excerpt })) });
  }

  open(question: string, title: string, signal: AbortSignal): string {
    signal.throwIfAborted();
    const record = this.recordsByQuestion.get(question.trim().toLowerCase());
    if (!record) return JSON.stringify({ status: "not_in_corpus" });
    const index = record.context.title.indexOf(title);
    if (index < 0) throw new AppError("TOOL_NOT_FOUND", "候选资料中没有这篇文章。");
    return JSON.stringify({ status: "ok", title, sentences: record.context.sentences[index]!
      .map((text, sentId) => ({ sentId, citation: `${title}#${sentId}`, text: text.trim() })) });
  }
}
