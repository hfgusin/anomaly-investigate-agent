import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { ResearchHotpotTool } from "../dist/tools/research-hotpot.js";
import { SkillRegistry } from "../dist/skills.js";
import { runHotpotCase } from "./hotpot-live-runner.mjs";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
const dataPath = resolve(process.env.HOTPOTQA_DATA_FILE || resolve(root, ".data/hotpotqa/validation.json"));
const limit = Number(process.argv[2] || 10);
const outputPath = resolve(process.argv[3] || resolve(root, ".data/hotpotqa/live-baseline.json"));
const seed = "2026-09-30-hard-bridge-v1";
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("题数必须为 1–100 的整数。");
if (!process.env.MODEL_BASE_URL || !process.env.MODEL_NAME) throw new Error(".env 缺少模型接口配置。");
const dataBytes = readFileSync(dataPath);
const records = JSON.parse(dataBytes.toString("utf8"));
const dataSha256 = createHash("sha256").update(dataBytes).digest("hex");
const sample = records.filter((item) => item.type === "bridge" && item.level === "hard")
  .map((record) => ({ record, key: createHash("sha256").update(`${seed}:${record.id}`).digest("hex") }))
  .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, limit).map((item) => item.record);
const runtime = new ChatCompletionsRuntime({ baseUrl: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME,
  apiKey: process.env.MODEL_API_KEY || "", toolResultMode: process.env.MODEL_TOOL_RESULT_MODE === "plain" ? "plain" : "standard" });
const tool = new ResearchHotpotTool(dataPath);
const skillInstruction = new SkillRegistry(root).select(`/research ${sample[0].question}`).instructions;
const results = [];
for (const [index, record] of sample.entries()) {
  const result = await runHotpotCase(record, runtime, tool, skillInstruction);
  results.push(result);
  process.stderr.write(`${index + 1}/${sample.length} ${record.id} ${result.status} answer=${result.score?.answerEM ?? false} support=${result.score?.supportEM ?? false}\n`);
  writeFileSync(outputPath, JSON.stringify({ seed, limit, model: process.env.MODEL_NAME, dataPath, dataSha256, results }, null, 2));
}
const completed = results.filter((item) => item.status === "completed");
const summary = { total: results.length, completed: completed.length,
  answerEM: completed.filter((item) => item.score.answerEM).length,
  meanAnswerF1: completed.reduce((sum, item) => sum + item.score.answerF1, 0) / results.length,
  supportEM: completed.filter((item) => item.score.supportEM).length,
  meanSupportF1: completed.reduce((sum, item) => sum + item.score.supportF1, 0) / results.length,
  jointEM: completed.filter((item) => item.score.jointEM).length,
  meanJointF1: completed.reduce((sum, item) => sum + item.score.jointF1, 0) / results.length,
  formatValid: completed.filter((item) => item.formatValid).length,
  allCitationsGrounded: completed.filter((item) => item.unsupportedCitations.length === 0).length,
  errors: results.filter((item) => item.status === "error").length };
writeFileSync(outputPath, JSON.stringify({ seed, limit, model: process.env.MODEL_NAME, dataPath, dataSha256, summary, results }, null, 2));
console.log(JSON.stringify({ outputPath, summary, ids: sample.map((item) => item.id) }, null, 2));
