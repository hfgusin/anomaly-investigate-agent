import { readPythonToolCatalog } from "./python-tool-catalog.js";
import { ResponsesRuntime } from "./providers/responses.js";
import { LangChainRuntime } from "./providers/langchain.js";
import { AgentRegistry } from "./agents.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { AppError } from "./session-store.js";
import { DemoRuntime, type AgentRuntime } from "./runtime.js";
import { ChatCompletionsRuntime } from "./providers/chat-completions.js";
import { ToolRegistry } from "./tools/read-file.js";
import { SkillRegistry } from "./skills.js";
import { DEFAULT_GATEWAY_LIMITS, DEFAULT_MODEL_LIMIT, type GatewayLimitConfig } from "./rate-limit.js";

export function readConfig(env: NodeJS.ProcessEnv, root: string): {
  runtime: AgentRuntime; port: number; timeoutMs: number; contextBudgetChars: number; databasePath: string;
  hotpotDataPath: string; tools: ToolRegistry; skills: SkillRegistry;
  gatewayLimits: GatewayLimitConfig; agents: AgentRegistry;
} {
  const limit = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new AppError("INVALID_CONFIG", `${key} 必须是 1–10000 的整数。`);
    return value;
  };
  const gatewayLimits = {
    global: { perMinute: limit("GATEWAY_REQUESTS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS.global.perMinute), burst: limit("GATEWAY_BURST", DEFAULT_GATEWAY_LIMITS.global.burst) },
    connection: { perMinute: limit("CONNECTION_REQUESTS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS.connection.perMinute), burst: limit("CONNECTION_BURST", DEFAULT_GATEWAY_LIMITS.connection.burst) },
    session: { perMinute: limit("SESSION_SENDS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS.session.perMinute), burst: limit("SESSION_SEND_BURST", DEFAULT_GATEWAY_LIMITS.session.burst) },
  };
  const port = Number(env.PORT ?? 18789);
  const timeoutMs = Number(env.RUN_TIMEOUT_MS ?? 120_000);
  const contextBudgetChars = Number(env.CONTEXT_BUDGET_CHARS ?? 120_000);
  const codeMode = env.MIRROR_ENABLE_CODE ?? "false";
  if (!["true", "false"].includes(codeMode)) throw new AppError("INVALID_CONFIG", "MIRROR_ENABLE_CODE 必须是 true 或 false。");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("INVALID_CONFIG", "PORT 必须是 1–65535 的整数。");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    throw new AppError("INVALID_CONFIG", "RUN_TIMEOUT_MS 必须在 1000–600000 之间。");
  }
  if (!Number.isInteger(contextBudgetChars) || contextBudgetChars < 4_096 || contextBudgetChars > 200_000) {
    throw new AppError("INVALID_CONFIG", "CONTEXT_BUDGET_CHARS 必须在 4096–200000 之间。");
  }
  const mode = env.MIRROR_RUNTIME ?? "demo";
  let runtime: AgentRuntime;
  if (mode === "demo") runtime = new DemoRuntime();
  else if (mode === "chat-completions" || mode === "responses") {
    if (!env.MODEL_BASE_URL?.trim()) throw new AppError("INVALID_CONFIG", "请在 .env 中填写 MODEL_BASE_URL。");
    const toolResultMode = env.MODEL_TOOL_RESULT_MODE ?? "standard";
    if (toolResultMode !== "standard" && toolResultMode !== "plain") {
      throw new AppError("INVALID_CONFIG", "MODEL_TOOL_RESULT_MODE 只支持 standard 或 plain。");
    }
    const webSearch = env.RESPONSES_WEB_SEARCH ?? "true";
    if (!["true", "false"].includes(webSearch)) throw new AppError("INVALID_CONFIG", "RESPONSES_WEB_SEARCH 必须是 true 或 false。");
    const thinking = env.MODEL_THINKING;
    if (thinking && !["enabled", "disabled"].includes(thinking)) throw new AppError("INVALID_CONFIG", "MODEL_THINKING 必须是 enabled 或 disabled。");
    const provider = {
      baseUrl: env.MODEL_BASE_URL.trim(), model: env.MODEL_NAME?.trim() ?? "", apiKey: env.MODEL_API_KEY?.trim() ?? "",
      toolResultMode: toolResultMode as "standard" | "plain",
      limits: { perMinute: limit("MODEL_REQUESTS_PER_MINUTE", DEFAULT_MODEL_LIMIT.perMinute),
        burst: limit("MODEL_REQUEST_BURST", DEFAULT_MODEL_LIMIT.burst), maxConcurrent: limit("MODEL_MAX_CONCURRENT", DEFAULT_MODEL_LIMIT.maxConcurrent!) },
    };
    const fullProvider = { ...provider, webSearch: webSearch === "true", maxKeyword: Number(env.RESPONSES_MAX_KEYWORD ?? 3),
      ...(thinking ? { thinking: thinking as "enabled" | "disabled" } : {}) };
    // Existing constructors still validate endpoint/config; no request is made here.
    const native = mode === "responses" ? new ResponsesRuntime(fullProvider) : new ChatCompletionsRuntime(provider);
    const engine = env.AGENT_ENGINE ?? "langchain";
    if (!["langchain", "native"].includes(engine)) throw new AppError("INVALID_CONFIG", "AGENT_ENGINE 支持 langchain 或 native。");
    runtime = engine === "langchain" ? new LangChainRuntime(root, fullProvider, native.info, env.AGENT_PYTHON) : native;
  } else throw new AppError("INVALID_CONFIG", "MIRROR_RUNTIME 支持 demo、chat-completions 或 responses。");
  const fullValidation = resolve(root, ".data/hotpotqa/validation.json");
  const datasetPath = resolve(env.HOTPOTQA_DATA_FILE || (existsSync(fullValidation)
    ? fullValidation : resolve(root, "data/hotpotqa/validation-sample.json")));
  const tools = new ToolRegistry(resolve(root, "workspace"), datasetPath, codeMode === "true");
  if (runtime instanceof LangChainRuntime) tools.setPythonTools(readPythonToolCatalog(root, env));
  return { runtime, port, timeoutMs, contextBudgetChars, databasePath: resolve(env.MIRROR_DATA_DIR || resolve(root, ".data"), "gateway.sqlite"),
    hotpotDataPath: datasetPath, tools,
    skills: new SkillRegistry(root), agents: existsSync(resolve(root, "config/agents.json")) ? AgentRegistry.fromFile(resolve(root, "config/agents.json")) : new AgentRegistry(), gatewayLimits };
}
