import { AppError } from "./session-store.js";

export function parseResearchCitations(output: string, available: Set<string>): {
  citations: string[]; invalid: string[];
} {
  const citations: string[] = [];
  const invalid: string[] = [];
  const known = [...available].sort((a, b) => b.length - a.length);
  for (const match of output.matchAll(/\[([^\[\]\n]+)\]/gu)) {
    const contents = match[1]!.trim();
    if (!/#\d+/u.test(contents)) continue;
    let rest = contents;
    while (rest) {
      const citation = known.find((candidate) => rest.startsWith(candidate) &&
        (rest.length === candidate.length || /^,\s*/u.test(rest.slice(candidate.length))));
      if (!citation) { invalid.push(rest); break; }
      citations.push(citation);
      rest = rest.slice(citation.length);
      if (!rest) break;
      rest = rest.replace(/^,\s*/u, "");
      if (!rest) invalid.push(contents);
    }
  }
  return { citations: [...new Set(citations)], invalid };
}

export function validateResearchCitations(output: string, result: string): void {
  let data: { status?: string; evidence?: Array<{ hop: number; sentences: Array<{ citation: string }> }> };
  try { data = JSON.parse(result); }
  catch { throw new AppError("RESEARCH_RESULT_INVALID", "研究工具返回的证据格式无效。"); }
  if (data.status !== "ok") return;
  const byHop = new Map<number, Set<string>>();
  for (const entry of data.evidence ?? []) {
    if (!byHop.has(entry.hop)) byHop.set(entry.hop, new Set());
    for (const sentence of entry.sentences ?? []) byHop.get(entry.hop)!.add(sentence.citation);
  }
  const available = new Set([...byHop.values()].flatMap((set) => [...set]));
  const { citations, invalid } = parseResearchCitations(output, available);
  if (invalid.length) {
    throw new AppError("RESEARCH_CITATION_INVALID", "研究回答引用了工具未返回的句子。");
  }
  if (![1, 2].every((hop) => citations.some((citation) => byHop.get(hop)?.has(citation)))) {
    throw new AppError("RESEARCH_CITATION_INCOMPLETE", "研究回答缺少首跳或次跳的句子出处。");
  }
}
