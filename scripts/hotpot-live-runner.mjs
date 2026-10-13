import { scoreHotpot } from "../dist/hotpot-eval.js";
import { parseResearchCitations } from "../dist/research-validation.js";

export async function runHotpotCase(record, runtime, tool, skillInstruction) {
  let output = "";
  let result;
  let toolCalls = 0;
  try {
    for await (const chunk of runtime.stream({ messages: [{ role: "user", content: `/research ${record.question}` }],
      signal: AbortSignal.timeout(120_000), skillInstruction,
      toolDefinitions: [tool.definition], maxToolResultChars: 30_000,
      callTool: async ({ name, arguments: raw }) => {
        toolCalls++;
        if (name !== tool.name) return { content: "Unknown tool", isError: true };
        result = JSON.parse(tool.execute(JSON.parse(raw), new AbortController().signal));
        return { content: JSON.stringify(result), isError: false };
      } })) {
      if (typeof chunk === "string") output += chunk;
      else if (chunk.type === "discard") output = output.slice(0, -chunk.chars);
    }
  } catch (error) {
    return { id: record.id, question: record.question, status: "error", error: error instanceof Error ? error.message : String(error),
      modelOutput: output, toolCalls, retrieval: result?.retrieval ?? null };
  }
  return { id: record.id, question: record.question, status: "completed", modelOutput: output,
    toolCalls, retrieval: result?.retrieval ?? null, ...scoreModelOutput(record, output, result) };
}

export function scoreModelOutput(record, output, result) {
  const available = new Set(result?.evidence?.flatMap((entry) => entry.sentences.map((sentence) => sentence.citation)) ?? []);
  const { citations, invalid: unsupportedCitations } = parseResearchCitations(output, available);
  const firstLine = output.trim().split(/\n/u)[0] ?? "";
  const formatValid = /^答案[:：]\s*\S/u.test(firstLine);
  const answer = formatValid ? firstLine.replace(/^答案[:：]\s*/u, "").replace(/\s*\[[^\]]+\].*$/u, "").trim() : "";
  const score = scoreHotpot(record, answer, citations);
  return { answerExtracted: answer, formatValid, citations, unsupportedCitations,
    score: { ...score, jointEM: score.answerEM && score.supportEM } };
}
