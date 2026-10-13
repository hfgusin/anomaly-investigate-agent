import type { HotpotRecord } from "./tools/research-hotpot.js";

export function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|an|the)\b/gu, " ").replace(/\s+/gu, " ").trim();
}

export function answerF1(prediction: string, gold: string): number {
  const predicted = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const expected = normalizeAnswer(gold).split(" ").filter(Boolean);
  if (["yes", "no", "noanswer"].includes(predicted.join(" ")) ||
      ["yes", "no", "noanswer"].includes(expected.join(" "))) {
    return predicted.join(" ") === expected.join(" ") ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of predicted) {
    const remaining = counts.get(token) ?? 0;
    if (remaining) { common++; counts.set(token, remaining - 1); }
  }
  if (!common) return 0;
  const precision = common / predicted.length;
  const recall = common / expected.length;
  return 2 * precision * recall / (precision + recall);
}

export function scoreHotpot(record: HotpotRecord, answer: string, cited: string[]) {
  const gold = new Set(record.supporting_facts.title.map((title, index) => `${title}#${record.supporting_facts.sent_id[index]}`));
  const prediction = new Set(cited);
  const truePositive = [...prediction].filter((item) => gold.has(item)).length;
  const precision = prediction.size ? truePositive / prediction.size : 0;
  const recall = gold.size ? truePositive / gold.size : 0;
  const supportF1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const answerEM = normalizeAnswer(answer) === normalizeAnswer(record.answer);
  const answerF1Score = answerF1(answer, record.answer);
  return { answerEM, answerF1: answerF1Score, supportPrecision: precision, supportRecall: recall, supportF1,
    jointF1: answerF1Score * supportF1,
    supportEM: prediction.size === gold.size && truePositive === gold.size,
    gold: [...gold], predicted: [...prediction] };
}

export function citedFacts(output: string): string[] {
  return [...new Set([...output.matchAll(/([^\n\[\]]+?)#(\d+)/gu)]
    .map((match) => `${match[1]?.trim().replace(/^[\[(,，。;；\s]+/u, "")}#${match[2]}`))];
}
