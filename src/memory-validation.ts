export type MemorySourceRun = { id: string; input: string; output: string };

const RUN_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const OPAQUE_CODE = /\b[A-Z][A-Za-z0-9]{1,24}[-_][A-Za-z0-9_-]{3,64}\b/g;

/** Conservative check for code-like facts; natural-language entailment remains unverified. */
export function validateMemoryEvidence(summary: string, sources: MemorySourceRun[]): string | null {
  if (/(?:忽略|无视).{0,24}(?:后续|之后).{0,8}(?:问题|指令|要求)|(?:忽略|无视).{0,24}(?:用户问题|系统指令)|(?:以后|后续|从现在).{0,24}(?:只|仅).{0,8}(?:回答|回复|写)|(?:只|仅).{0,8}(?:回答|回复|写).{0,16}(?:别|不要|不).{0,8}(?:回答|回复)/u.test(summary)) {
    return "摘要包含针对未来回答的旧指令。";
  }
  const cited = new Set((summary.match(RUN_ID) ?? []).map((id) => id.toLowerCase()));
  const sourceById = new Map(sources.map((run) => [run.id, run]));
  if (!cited.size) return "摘要没有来源 Run ID。";
  for (const id of cited) if (!sourceById.has(id)) return "摘要引用了摘录以外的 Run ID。";

  const codes = new Set(summary.match(OPAQUE_CODE) ?? []);
  for (const code of codes) {
    const supporting = sources.filter((run) => run.input.includes(code) || run.output.includes(code));
    if (!supporting.length) return `摘要包含原始 Run 中不存在的标识符：${code}。`;
    if (!supporting.some((run) => cited.has(run.id))) return `摘要中的标识符 ${code} 未引用对应 Run。`;
    for (const line of summary.split("\n")) {
      if (!line.includes(code)) continue;
      const localIds = new Set((line.match(RUN_ID) ?? []).map((id) => id.toLowerCase()));
      if (localIds.size && !supporting.some((run) => localIds.has(run.id))) {
        return `摘要中的标识符 ${code} 指向了不支持它的 Run。`;
      }
    }
  }
  return null;
}
