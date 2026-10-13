import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { ResearchWorkerClient } from "../dist/tools/research-worker-client.js";
import { ResearchSession } from "../dist/tools/research-session.js";
import { SkillRegistry } from "../dist/skills.js";
import { scoreModelOutput } from "./hotpot-live-runner.mjs";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
if (!process.env.MODEL_BASE_URL || !process.env.MODEL_NAME) throw new Error(".env 缺少模型接口配置。");
const dataPath = resolve(process.env.HOTPOTQA_DATA_FILE || resolve(root, ".data/hotpotqa/validation.json"));
const records = JSON.parse(readFileSync(dataPath, "utf8"));
const record = records.find((item) => item.id === process.argv[2]);
if (!record) throw new Error("请提供已加载的 HotpotQA 题目 ID。");
const outputPath = resolve(process.argv[3] || resolve(root, `.data/hotpotqa/v2-${record.id}.json`));
const runtime = new ChatCompletionsRuntime({ baseUrl: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME, apiKey: process.env.MODEL_API_KEY || "", toolResultMode: "standard" });
const worker = new ResearchWorkerClient(dataPath);
const session = new ResearchSession(record.question, worker);
const skill = new SkillRegistry(root).select(`/research2 ${record.question}`);
const calls = [];
const evidence = [];
const signal = AbortSignal.timeout(120_000);
let output = "";
let error;
try {
  for await (const chunk of runtime.stream({ messages: [{ role: "user", content: `/research2 ${record.question}` }],
    signal, skillInstruction: skill.instructions,
    toolResultMode: "standard", toolDefinitions: session.definitions, maxToolResultChars: 30_000,
    callTool: async (call) => {
      const result = await session.execute(call.name, call.arguments, signal);
      calls.push({ name: call.name, arguments: call.arguments, isError: result.isError, result: result.content });
      if (call.name === "open_passage" && !result.isError) {
        const opened = JSON.parse(result.content);
        if (opened.status === "ok") evidence.push(opened);
      }
      return result;
    } })) {
    if (typeof chunk === "string") output += chunk;
    else if (chunk.type === "discard") output = output.slice(0, -chunk.chars);
  }
  session.validate(output);
} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
finally { await worker.close(); }

const scored = scoreModelOutput(record, output, { evidence });
const report = { id: record.id, question: record.question, model: process.env.MODEL_NAME,
  status: error ? "error" : "completed", ...(error ? { error } : {}), output, calls, ...scored };
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, id: report.id, status: report.status, error,
  calls: calls.map((call) => ({ name: call.name, isError: call.isError })),
  answer: scored.answerExtracted, answerEM: scored.score.answerEM,
  supportEM: scored.score.supportEM, jointEM: scored.score.jointEM, citations: scored.citations }, null, 2));
