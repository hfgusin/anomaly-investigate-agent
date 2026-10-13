import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);
if (!process.env.MODEL_BASE_URL || !process.env.MODEL_NAME) throw new Error(".env 缺少模型接口配置。");

const sourceId = randomUUID();
const marker = `M-${randomUUID().slice(0, 8)}`;
const runtime = new ChatCompletionsRuntime({ baseUrl: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME, apiKey: process.env.MODEL_API_KEY || "", toolResultMode: "standard" });
const toolDefinitions = [
  { type: "function", function: { name: "find_source", description: "Find the source ID for the project code.",
    parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false } } },
  { type: "function", function: { name: "read_source", description: "Read a source by its exact ID returned by find_source.",
    parameters: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"], additionalProperties: false } } },
];
const calls = [];
let output = "";
let error;
try {
  for await (const chunk of runtime.stream({
    messages: [{ role: "user", content: "Find the project code. First call find_source. Then call read_source using the exact source_id returned by find_source. Answer with only the code found in that source; do not guess." }],
    signal: AbortSignal.timeout(120_000), toolDefinitions, maxToolResultChars: 10_000,
    callTool: async (call) => {
      let args;
      try { args = JSON.parse(call.arguments); }
      catch { args = {}; }
      calls.push({ name: call.name, arguments: args });
      if (call.name === "find_source") return { content: JSON.stringify({ source_id: sourceId }), isError: false };
      if (call.name === "read_source" && args.source_id === sourceId) {
        return { content: JSON.stringify({ text: `The project code is ${marker}.` }), isError: false };
      }
      return { content: "Unknown source ID or tool.", isError: true };
    },
  })) {
    if (typeof chunk === "string") output += chunk;
    else if (chunk.type === "discard") output = output.slice(0, -chunk.chars);
  }
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
}

const passed = !error && calls.length === 2 && calls[0]?.name === "find_source" &&
  calls[1]?.name === "read_source" && calls[1].arguments.source_id === sourceId && output.trim() === marker;
const report = { model: process.env.MODEL_NAME, mode: "standard", passed, calls, output, expected: marker,
  ...(error ? { error } : {}) };
const outputPath = resolve(process.argv[2] || resolve(root, ".data/model-multiround-standard.json"));
writeFileSync(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputPath, model: report.model, passed, callNames: calls.map((call) => call.name),
  answerMatched: output.trim() === marker, ...(error ? { error } : {}) }, null, 2));
if (!passed) process.exitCode = 1;
