import { readFileSync, existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { ResearchHotpotTool } from "../dist/tools/research-hotpot.js";
import { SkillRegistry } from "../dist/skills.js";
import { scoreHotpot } from "../dist/hotpot-eval.js";
import { parseResearchCitations } from "../dist/research-validation.js";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
const dataPath = resolve(process.env.HOTPOTQA_DATA_FILE || resolve(root, "data/hotpotqa/validation-sample.json"));
const records = JSON.parse(readFileSync(dataPath, "utf8"));
const record = records.find((item) => item.id === (process.argv[2] || records[0]?.id));
if (!record) throw new Error("没有找到指定的 HotpotQA 题目 ID。");
if (!process.env.MODEL_BASE_URL || !process.env.MODEL_NAME) throw new Error(".env 缺少模型接口配置。");
const runtime = new ChatCompletionsRuntime({ baseUrl: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME,
  apiKey: process.env.MODEL_API_KEY || "", toolResultMode: process.env.MODEL_TOOL_RESULT_MODE === "plain" ? "plain" : "standard" });
const tool = new ResearchHotpotTool(dataPath);
const skill = new SkillRegistry(root).select(`/research ${record.question}`);
let output = "";
let result;
for await (const chunk of runtime.stream({ messages: [{ role: "user", content: `/research ${record.question}` }],
  signal: AbortSignal.timeout(120_000), skillInstruction: skill.instructions,
  toolDefinitions: [tool.definition], maxToolResultChars: 20_000,
  callTool: async ({ name, arguments: raw }) => {
    if (name !== tool.name) return { content: "Unknown tool", isError: true };
    result = JSON.parse(tool.execute(JSON.parse(raw), new AbortController().signal));
    return { content: JSON.stringify(result), isError: false };
  } })) {
  if (typeof chunk === "string") output += chunk;
  else if (chunk.type === "discard") output = output.slice(0, -chunk.chars);
}
const available = new Set(result?.evidence.flatMap((entry) => entry.sentences.map((sentence) => sentence.citation)) || []);
const { citations, invalid: unsupportedCitations } = parseResearchCitations(output, available);
// The first line is the final answer. The remaining prose may explain the bridge.
const answer = output.trim().split(/\n/u)[0].replace(/^答案[:：]\s*/u, "").replace(/\s*\[[^\]]+\].*$/u, "").trim();
console.log(JSON.stringify({ id: record.id, question: record.question, modelOutput: output, answerExtracted: answer,
  retrieval: result?.retrieval ?? null, citations, unsupportedCitations, score: scoreHotpot(record, answer, citations) }, null, 2));
