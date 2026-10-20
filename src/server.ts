import type { AgentRegistry } from "./agents.js";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Gateway } from "./gateway.js";
import { AppError, SessionStore } from "./session-store.js";
import { readConfig } from "./config.js";
import type { AgentRuntime } from "./runtime.js";
import type { ToolRegistry } from "./tools/read-file.js";
import type { SkillRegistry } from "./skills.js";
import { EvaluationReportReader } from "./evaluation-report.js";
import type { GatewayLimitConfig } from "./rate-limit.js";
import { VerificationReportReader } from "./verification-report.js";
import { AutomationDashboard } from "./automation-dashboard.js";
import { DailyScan } from "./daily-scan.js";
import { pythonRouter } from "./intent-router.js";
import { DiExportTool } from "./tools/di-export.js";
import { growthTopic } from "./growth-topic.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function createApplication(store: SessionStore, runtime: AgentRuntime, timeoutMs = 120_000,
  tools?: ToolRegistry, contextBudgetChars = 120_000, skills?: SkillRegistry,
  evaluation?: EvaluationReportReader, limits?: GatewayLimitConfig, agents?: AgentRegistry,
  debugObserver?: (event: string, payload: Record<string, unknown>) => void) {
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [url, file, type] of [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/client-state.js", "client-state.js", "text/javascript"],
    ["/task-view-model.js", "task-view-model.js", "text/javascript"],
    ["/styles.css", "styles.css", "text/css"],
    ["/automation-dashboard.js", "automation-dashboard.js", "text/javascript"],
    ["/growth-view.js", "growth-view.js", "text/javascript"],
  ] as const) assets.set(url, { body: await readFile(resolve(root, "public", file)), type });

  const gateway = new Gateway(store, runtime, timeoutMs, tools, contextBudgetChars, skills, evaluation, limits,
    new VerificationReportReader(resolve(root, ".data/verification/latest.json"), root), agents, debugObserver);
  const dashboard = new AutomationDashboard(root);
  await dashboard.init();
  const dailyScan = new DailyScan(root);
  tools?.setAutomationReader(date => dashboard.snapshot(date));
  const diDownloads = tools?.diExport ?? new DiExportTool(root);
  const server = createServer((request, response) => {
    if (!validHost(request)) { response.writeHead(403); response.end(); return; }
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const url = new URL(request.url ?? "/", "http://localhost");
    const traceRequest = /^\/api\/runs\/([0-9a-f-]{36})\/trace\.json$/.exec(url.pathname);
    if (traceRequest) {
      if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405); response.end(); return; }
      try {
        const trace = store.traceForRun(traceRequest[1]!);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="run-${traceRequest[1]}.json"` });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify(trace, null, 2));
      } catch (error) { response.writeHead(error instanceof AppError && error.code === "RUN_NOT_FOUND" ? 404 : 500); response.end(); }
      return;
    }
    if (url.pathname === "/api/topics" && (request.method === "GET" || request.method === "HEAD")) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ topics: [growthTopic] }));
      return;
    }
    const csvRequest = /^\/api\/di-exports\/([0-9a-f-]{36})\.csv$/.exec(url.pathname);
    if (csvRequest) {
      if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405); response.end(); return; }
      void diDownloads.download(csvRequest[1]!).then(file => {
        if (!file) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-length": file.size, "content-disposition": `attachment; filename="${file.filename}"` });
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(file.path);
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      }).catch(() => { response.writeHead(500); response.end(); });
      return;
    }
    if (url.pathname === "/api/automation/view" || url.pathname === "/api/automation/refresh") {
      const refresh = url.pathname.endsWith("refresh");
      if (request.method !== (refresh ? "POST" : "GET")) { response.writeHead(405); response.end(); return; }
      if (refresh && request.headers.origin !== `http://${request.headers.host}`) { response.writeHead(403); response.end(); return; }
      const date = url.searchParams.get("date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
      void (refresh ? dashboard.start(date) : dashboard.snapshot(date)).then(data => {
        response.writeHead(refresh ? 202 : 200, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(data));
      }).catch(() => { response.writeHead(400, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({error:"读取失败：检查日期格式、本地快照或 DI session 配置。"})); });
      return;
    }
    if (url.pathname === "/api/daily-scan" || url.pathname === "/api/daily-scan/run") {
      const run = url.pathname.endsWith("run");
      if (request.method !== (run ? "POST" : "GET")) { response.writeHead(405); response.end(); return; }
      if (run && request.headers.origin !== `http://${request.headers.host}`) { response.writeHead(403); response.end(); return; }
      void (run ? dailyScan.scan() : dailyScan.latest()).then(data => {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(data));
      }).catch(() => { response.writeHead(500); response.end(); });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405); response.end(); return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", runtime: runtime.info }));
      return;
    }
    const asset = assets.get(request.url ?? "");
    if (asset) {
      response.writeHead(200, { "content-type": `${asset.type}; charset=utf-8` });
      response.end(request.method === "HEAD" ? undefined : asset.body);
      return;
    }
    response.writeHead(404); response.end();
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 512_000 });
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== "/gateway" || !validHost(request) ||
      (origin !== undefined && origin !== `http://${request.headers.host}`)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => gateway.attach(client));
  });

  function validHost(request: IncomingMessage): boolean {
    const address = server.address();
    if (!address || typeof address === "string") return false;
    return request.headers.host === `127.0.0.1:${address.port}` || request.headers.host === `localhost:${address.port}`;
  }

  async function close(): Promise<void> {
    dashboard.close();
    dailyScan.close();
    const closed = new Promise<void>((done) => server.close(() => done()));
    await gateway.shutdown();
    await tools?.close();
    for (const socket of websocketServer.clients) socket.terminate();
    websocketServer.close();
    server.closeAllConnections();
    await closed;
  }
  return { server, gateway, dailyScan, close };
}

async function main(): Promise<void> {
  const envPath = resolve(root, ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
  const config = readConfig(process.env, root);
  const store = new SessionStore(config.databasePath);
  let application: Awaited<ReturnType<typeof createApplication>>;
  try {
    const resumable = store.requeueResearchRuns();
    const recovered = store.recoverInterrupted();
    application = await createApplication(store, config.runtime, config.timeoutMs, config.tools, config.contextBudgetChars,
      config.skills, new EvaluationReportReader(resolve(root, ".data/hotpotqa/gateway-paired-2026-09-30.json"), config.hotpotDataPath), config.gatewayLimits, config.agents);
    application.gateway.coordinator.resumeQueuedResearchRuns();
    application.dailyScan.start();
    if (process.env.MIRROR_ROUTER === "true") application.gateway.coordinator.setRouter(pythonRouter(root));
    await new Promise<void>((done, reject) => {
      application.server.once("error", reject);
      application.server.listen(config.port, "127.0.0.1", () => {
        application.server.off("error", reject);
        done();
      });
    });
    process.stdout.write(`OpenClaw Mirror: http://127.0.0.1:${config.port}\n模式：${config.runtime.info.label}\n标记中断：${recovered} · 重新排队的研究任务：${resumable}\n`);
  } catch (error) { store.close(); throw error; }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    try { await application.close(); store.close(); }
    finally { clearTimeout(deadline); }
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`启动失败：${error instanceof Error ? error.message : "未知错误"}\n`);
    process.exitCode = 1;
  });
}
