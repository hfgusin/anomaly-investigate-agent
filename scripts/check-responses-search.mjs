import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { ResponsesRuntime } from "../dist/providers/responses.js";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const baseUrl = process.env.MODEL_BASE_URL?.trim();
const model = process.env.MODEL_NAME?.trim();
const apiKey = process.env.MODEL_API_KEY?.trim() ?? "";
if (!baseUrl || !model || !apiKey) throw new Error(".env 需要 MODEL_BASE_URL、MODEL_NAME 和 MODEL_API_KEY。");

const question = process.argv[2] ?? "请联网查询今天的一条热点新闻，注明新闻发生日期，并给出来源链接。";
const runtime = new ResponsesRuntime({
  baseUrl, model, apiKey,
  webSearch: process.env.RESPONSES_WEB_SEARCH !== "false",
  maxKeyword: Number(process.env.RESPONSES_MAX_KEYWORD ?? 3),
});

const searches = [];
const sources = [];
let text = "";
let error;
try {
  for await (const chunk of runtime.stream({
    messages: [{ role: "user", content: question }],
    signal: AbortSignal.timeout(120_000),
  })) {
    if (typeof chunk === "string") text += chunk;
    else if (chunk.type === "provider_event" && chunk.event === "web.search") searches.push(chunk.payload);
    else if (chunk.type === "provider_event" && chunk.event === "web.sources") sources.push(...(chunk.payload.sources ?? []));
  }
} catch (cause) {
  error = cause instanceof Error ? `${cause.code ? `${cause.code}: ` : ""}${cause.message}` : String(cause);
}

const passed = !error && text.trim().length > 0 && (searches.length > 0 || sources.length > 0);
const report = {
  model,
  webSearch: runtime.info.webSearch,
  question,
  passed,
  searchCount: searches.length,
  searches,
  sources,
  answer: text.trim().slice(0, 1200),
  ...(error ? { error } : {}),
};
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
