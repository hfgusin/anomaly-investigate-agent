/** Transitional Gateway -> Python bridge. Model and tool loop live in Python. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { AppError } from "../session-store.js";
import { RequestLimiter, DEFAULT_MODEL_LIMIT } from "../rate-limit.js";
import type { AgentRuntime, RuntimeInput, RuntimeChunk, RuntimeInfo } from "../runtime.js";
import type { ProviderConfig } from "./chat-completions.js";

type Config = ProviderConfig & { webSearch?: boolean; maxKeyword?: number; thinking?: "enabled" | "disabled" };

export class LangChainRuntime implements AgentRuntime {
  readonly info: RuntimeInfo;
  private readonly limiter: RequestLimiter;
  constructor(private root: string, private config: Config, info: RuntimeInfo, private python?: string) {
    this.info = { ...info, label: `${info.label} · Python LangChain` };
    this.limiter = new RequestLimiter(config.limits ?? DEFAULT_MODEL_LIMIT);
  }
  limits() { return this.limiter.snapshot(); }
  promptOverheadChars(definitions?: unknown[], skill?: string) {
    // Conservative allowance for Python system instruction + message wrappers.
    return 1000 + JSON.stringify(definitions ?? []).length + (skill?.length ?? 0);
  }
  async *stream(input: RuntimeInput): AsyncIterable<RuntimeChunk> {
    input.signal.throwIfAborted();
    const bundled = resolve(this.root, ".venv-di/bin/python");
    const candidate = this.python || (existsSync(bundled) ? bundled : "python3");
    const python = candidate.includes("/") ? resolve(this.root, candidate) : candidate;
    const child = spawn(python, ["-m", "agent_backend.runtime"], {
      cwd: resolve(this.root, "python"), stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1",
        LANGCHAIN_TRACING_V2: "false", LANGSMITH_TRACING: "false",
        MIRROR_RUNTIME: this.info.kind, MODEL_BASE_URL: this.config.baseUrl, MODEL_NAME: this.config.model,
        MODEL_API_KEY: this.config.apiKey, MODEL_THINKING: this.config.thinking ?? "",
        RESPONSES_WEB_SEARCH: String(this.config.webSearch !== false), RESPONSES_MAX_KEYWORD: String(this.config.maxKeyword ?? 3) },
    });
    let spawnError = false; let stderrBytes = 0;
    child.on("error", () => { spawnError = true; });
    // Drain diagnostics without logging provider bodies, prompts or credentials.
    child.stderr.on("data", data => { stderrBytes += data.length; if (stderrBytes > 128_000) child.kill(); });
    const exited = new Promise<number | null>(done => child.once("close", done));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const events = lines[Symbol.asyncIterator]();
    let release: (() => void) | undefined;
    let completed = false; let frameCount = 0; let escalation: NodeJS.Timeout | undefined;
    const stop = () => {
      lines.close(); child.kill("SIGTERM");
      if (!escalation && child.exitCode === null && child.signalCode === null) {
        escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
        escalation.unref();
      }
    };
    input.signal.addEventListener("abort", stop, { once: true });
    const send = (value: unknown) => new Promise<void>((done, reject) => {
      child.stdin.write(JSON.stringify(value) + "\n", error => error ? reject(error) : done());
    });
    // Avoid an unhandled EPIPE when stop closes a child waiting for approval.
    child.stdin.on("error", () => undefined);
    try {
      await send({ type: "start", messages: input.messages,
        toolDefinitions: input.callTool ? input.toolDefinitions ?? [] : [],
        ...(input.activeToolNames ? { activeToolNames: input.activeToolNames } : {}),
        hostedSearch: input.hostedSearch !== false, toolResultMode: input.toolResultMode ?? this.config.toolResultMode ?? "standard",
        maxToolResultChars: input.maxToolResultChars ?? (this.info.kind === "responses" ? 32768 : 200000),
        ...(input.skillInstruction ? { skillInstruction: input.skillInstruction } : {}) });
      for await (const line of { [Symbol.asyncIterator]: () => events }) {
        input.signal.throwIfAborted();
        if (line.length > 2_000_000 || ++frameCount > 200_000) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 事件超过限制。");
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 返回无效事件。"); }
        if (!event || typeof event !== "object") throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 事件格式错误。");
        switch (event.type) {
          case "model_request":
            try { input.debugEvent?.("model.request", {}); } catch { /* Debug must not affect execution. */ }
            if (release) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "模型许可未释放。");
            release = this.limiter.take("MODEL_RATE_LIMITED");
            try { input.debugEvent?.("model.allowed", {}); } catch { /* Debug must not affect execution. */ }
            await send({ type: "model_allowed" }); break;
          case "model_release":
            try { input.debugEvent?.("model.released", {}); } catch { /* Debug must not affect execution. */ }
            if (!release) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "没有待释放的模型许可。");
            release(); release = undefined; break;
          case "text":
            if (typeof event.text !== "string") throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 文本事件无效。");
            yield event.text; break;
          case "discard":
            if (!Number.isInteger(event.chars) || event.chars < 0) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 撤回事件无效。");
            yield { type: "discard", chars: event.chars }; break;
          case "provider_event":
            if (!["web.search", "web.sources", "agent.action"].includes(event.event) || !event.payload || typeof event.payload !== "object") {
              throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 搜索事件无效。");
            }
            if (event.event === "agent.action" && (typeof event.payload.text !== "string" || event.payload.text.length > 1600)) {
              throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 行动说明无效。");
            }
            yield { type: "provider_event", event: event.event, payload: event.payload }; break;
          case "python_tool_call": {
            if (!input.callTool || release || typeof event.id !== "string" || typeof event.name !== "string" ||
                typeof event.arguments !== "string" || event.arguments.length > 8192) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 工具调用无效。");
            let executed = false;
            const result = await input.callTool({ id: event.id, name: event.name, arguments: event.arguments }, async argumentsJson => {
              if (executed) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "工具不能重复执行。");
              executed = true;
              await send({ type: "tool_approval", id: event.id, approved: true, arguments: JSON.parse(argumentsJson) });
              const next = await events.next();
              if (next.done || next.value.length > 2_000_000) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 工具未返回结果。");
              const completed = JSON.parse(next.value);
              if (completed.type !== "tool_executed" || completed.id !== event.id || typeof completed.content !== "string" ||
                  typeof completed.isError !== "boolean") throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 工具结果无效。");
              return { content: completed.content, isError: completed.isError, effectUnknown: completed.effectUnknown === true };
            });
            if (!executed && !result.isError && !result.denied) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "审批未调用 Python 执行入口。");
            await send({ type: "tool_result", id: event.id, ...result }); break;
          }
          case "tool_call": {
            if (!input.callTool || release || typeof event.id !== "string" || typeof event.name !== "string" ||
              typeof event.arguments !== "string" || event.arguments.length > 8192) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 工具调用无效。");
            const result = await input.callTool({ id: event.id, name: event.name, arguments: event.arguments });
            input.signal.throwIfAborted();
            await send({ type: "tool_result", id: event.id, ...result }); break;
          }
          case "done":
            if (release) throw new AppError("LANGCHAIN_BRIDGE_ERROR", "模型许可未释放便结束。");
            completed = true; break;
          case "error":
            throw new AppError(typeof event.code === "string" ? event.code : "LANGCHAIN_RUNTIME_ERROR",
              typeof event.message === "string" ? event.message : "Python LangChain 运行失败。");
          default: throw new AppError("LANGCHAIN_BRIDGE_ERROR", "未知 Python 事件。");
        }
        if (completed) break;
      }
      if (!completed) throw new AppError("LANGCHAIN_BRIDGE_ERROR", spawnError
        ? "无法启动 Python，请检查 AGENT_PYTHON 和 LangChain 依赖。" : "Python 进程提前结束；本次未标记成功。");
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (error instanceof AppError) throw error;
      throw new AppError("LANGCHAIN_BRIDGE_ERROR", "Python 通信失败；已保留部分输出。");
    } finally {
      input.signal.removeEventListener("abort", stop);
      release?.(); stop(); await exited;
      if (escalation) clearTimeout(escalation);
    }
  }
}
