import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ResearchHotpotTool } from "../dist/tools/research-hotpot.js";

const path = resolve(process.argv[2] || ".data/hotpotqa/validation.json");
const rows = JSON.parse(readFileSync(path, "utf8"));
const tool = new ResearchHotpotTool(path);
const metrics = { total: rows.length, fullEvidenceRecallCount: 0, goldFactsRetrieved: 0, totalGoldFacts: 0,
  linkedSecondHopCount: 0, unavailableCount: 0 };
for (const record of rows) {
  const result = JSON.parse(tool.execute({ question: record.question }, new AbortController().signal));
  if (result.status !== "ok") { metrics.unavailableCount++; continue; }
  const retrieved = new Set(result.evidence.flatMap((entry) => entry.sentences.map((sentence) => sentence.citation)));
  const gold = record.supporting_facts.title.map((title, index) => `${title}#${record.supporting_facts.sent_id[index]}`);
  const hits = gold.filter((citation) => retrieved.has(citation)).length;
  metrics.goldFactsRetrieved += hits;
  metrics.totalGoldFacts += gold.length;
  if (hits === gold.length) metrics.fullEvidenceRecallCount++;
  if (result.retrieval.secondHop.some((entry) => entry.linkedFromFirstHop)) metrics.linkedSecondHopCount++;
}
console.log(JSON.stringify({ ...metrics, fullEvidenceRecall: metrics.fullEvidenceRecallCount / metrics.total,
  supportingFactRecall: metrics.goldFactsRetrieved / metrics.totalGoldFacts }, null, 2));
