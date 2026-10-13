/** 真实 Gateway 调试入口。运行 npm run debug，然后在网页发送问题。 */
import { loadEnvFile } from "node:process";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readConfig } from "../dist/config.js";
import { SessionStore } from "../dist/session-store.js";
import { createApplication } from "../dist/server.js";
import { EvaluationReportReader } from "../dist/evaluation-report.js";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
const config = readConfig(process.env, root);
const showContent = process.env.DEBUG_CONTENT === "1";
const directory = resolve(root, ".data/debug");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const logFile = resolve(directory, `flow-${Date.now()}.jsonl`);
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /KEY|TOKEN|PASSWORD|COOKIE|SECRET|AUTHORIZATION/i.test(key) && value?.length >= 6)
  .map(([, value]) => value).sort((a, b) => b.length - a.length);

// 只记录流程摘要；DEBUG_CONTENT=1 才显示消息/工具结果节选。始终遮盖已知密钥。
function redact(value, key = "") {
  if (/key|token|password|cookie|secret|authorization/i.test(key)) return "[隐藏]";
  if (typeof value === "string") {
    for (const secret of secrets) value = value.split(secret).join("[隐藏]");
    return value.slice(0, 4000);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(v => redact(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
const labels = {
  "request.received": "① Gateway 收到网页请求", "request.failed": "请求未被接受",
  "run.state": "② 任务状态 / 检查点", "context.ready": "③ 上下文已组装，进入真实 Runtime",
  "model.first_text": "④ 收到模型首段文本", "model.event": "模型/联网事件",
  "tool.request": "⑤ 模型请求工具，进入 Gateway 审批", "tool.return": "⑥ Gateway 返回工具结果，回填模型",
  "runtime.done": "⑦ Runtime 输出结束", "runtime.error": "Runtime 中断或失败",
  "model.request": "Python 准备本轮模型请求，申请限流许可",
  "model.allowed": "已获得许可，Python 开始请求模型",
  "model.released": "本轮模型流结束，释放许可",
};
let sequence = 0, writtenBytes = 0, fileEnabled = true;
function log(event, data) {
  try {
    const record = { seq: ++sequence, time: new Date().toISOString(), event, ...redact(data) };
    const line = JSON.stringify(record) + "\n";
    console.log(`\n[${record.seq}] ${labels[event] ?? event}\n${JSON.stringify(redact(data), null, 2)}`);
    writtenBytes += Buffer.byteLength(line);
    if (fileEnabled && writtenBytes <= 10 * 1024 * 1024) appendFileSync(logFile, line, { mode: 0o600 });
    else if (fileEnabled) { fileEnabled = false; console.error("调试文件已达 10MB，后续只输出终端。"); }
  } catch { /* 日志写入失败不影响任务执行。 */ }
}
const phases = new Map();
function observe(event, payload) {
  if (event === "request.received") {
    const { request } = payload, params = request.params ?? {};
    log(event, { requestId: request.id, method: request.method,
      sessionId: params.sessionId, runId: params.runId, topicId: params.topicId, decision: params.decision,
      contentChars: params.content?.length, ...(showContent ? { content: params.content } : {}) });
  } else if (event === "run.updated") {
    const { run } = payload;
    const checkpoint = JSON.parse(run.checkpoint || "{}");
    const tools = JSON.parse(run.toolTrace || "[]").map(c => ({ id: c.id, name: c.name, status: c.status }));
    const signature = JSON.stringify([run.status, checkpoint.phase, tools]);
    if (phases.get(run.id) === signature) return; // 每个 token 都落库，但不刷屏。
    phases.set(run.id, signature);
    if (phases.size > 1000) phases.delete(phases.keys().next().value);
    log("run.state", { runId: run.id, sessionId: run.sessionId, status: run.status,
      phase: checkpoint.phase, tools, outputChars: run.output.length, error: run.error });
  } else log(event, payload);
}

// 包装而非重写：仍执行配置里的 Python LangChain / 原生 Runtime。
const runtime = {
  info: config.runtime.info,
  promptOverheadChars: config.runtime.promptOverheadChars?.bind(config.runtime),
  limits: config.runtime.limits?.bind(config.runtime),
  async *stream(input) {
    const traceId = randomUUID(); let chunks = 0, chars = 0, firstText = false;
    log("context.ready", { traceId, runId: input.runId, model: config.runtime.info.model,
      messages: input.messages.map(m => ({ role: m.role, chars: m.content.length, ...(showContent ? { content: m.content } : {}) })),
      skillChars: input.skillInstruction?.length ?? 0,
      tools: (input.toolDefinitions ?? []).map(d => d.function?.name),
      hostedSearch: input.hostedSearch !== false, toolResultMode: input.toolResultMode,
      maxToolResultChars: input.maxToolResultChars });
    const callTool = input.callTool ? async call => {
      let args; try { args = JSON.parse(call.arguments); } catch { args = "无效 JSON"; }
      log("tool.request", { traceId, toolCallId: call.id, name: call.name,
        arguments: showContent ? args : { fields: Object.keys(args ?? {}), action: args?.action, table: args?.table } });
      // 这里会停在审批；真正批准与执行发生在 run-coordinator.ts 的 callTool 中。
      const result = await input.callTool(call);
      log("tool.return", { traceId, toolCallId: call.id, isError: result.isError ?? false,
        denied: result.denied ?? false, resultChars: result.content.length,
        ...(showContent ? { result: result.content } : {}) });
      return result;
    } : undefined;
    try {
      for await (const chunk of config.runtime.stream({ ...input,
        debugEvent: (event, payload) => log(event, { traceId, runId: input.runId, ...payload }),
        ...(callTool ? { callTool } : {}) })) {
        if (typeof chunk === "string") {
          chars += chunk.length; chunks++;
          if (!firstText) { firstText = true; log("model.first_text", { traceId, chars: chunk.length }); }
        } else log("model.event", { traceId, type: chunk.type, event: chunk.event });
        yield chunk;
      }
      log("runtime.done", { traceId, chunks, streamedChars: chars });
    } catch (error) {
      log("runtime.error", { traceId, code: error.code ?? "ERROR", aborted: input.signal.aborted });
      throw error;
    }
  },
};

let store, app;
async function main() {
  // 与正常服务一样，持有同一 SQLite；已有 Gateway 未关闭时会明确报 STORE_IN_USE。
  store = new SessionStore(config.databasePath);
  store.requeueResearchRuns(); store.recoverInterrupted();
  try {
    app = await createApplication(store, runtime, config.timeoutMs, config.tools, config.contextBudgetChars,
      config.skills, new EvaluationReportReader(resolve(root, ".data/hotpotqa/gateway-paired-2026-09-30.json"), config.hotpotDataPath),
      config.gatewayLimits, config.agents, observe);
    app.gateway.coordinator.resumeQueuedResearchRuns();
    await new Promise((done, reject) => {
      app.server.once("error", reject);
      app.server.listen(config.port, "127.0.0.1", () => { app.server.off("error", reject); done(); });
    });
    console.log(`\n调试服务：http://127.0.0.1:${config.port}\n日志文件：${logFile}\nDEBUG_CONTENT=${showContent ? "1（显示内容节选）" : "0（只显示流程摘要）"}\n在网页发消息；Ctrl+C 退出。`);
  } catch (error) { await app?.close(); store.close(); throw error; }
}
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 5000); timer.unref();
  try { await app?.close(); store?.close(); } finally { clearTimeout(timer); }
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
main().catch(error => { console.error(`调试服务启动失败：${error.code ?? "ERROR"} ${error.message}`); process.exitCode = 1; });
