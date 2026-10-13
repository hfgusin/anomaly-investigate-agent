import type { AgentRegistry } from "./agents.js";
import { WebSocket } from "ws";
import { parseRequest, type GatewayEvent, type GatewayResponse } from "./protocol.js";
import type { AgentRuntime } from "./runtime.js";
import { AppError, SessionStore } from "./session-store.js";
import { RunCoordinator } from "./run-coordinator.js";
import type { ToolRegistry } from "./tools/read-file.js";
import type { SkillRegistry } from "./skills.js";
import type { EvaluationReportReader } from "./evaluation-report.js";
import { DEFAULT_GATEWAY_LIMITS, RequestLimiter, SessionRateLimits, type GatewayLimitConfig } from "./rate-limit.js";
import type { VerificationReportReader } from "./verification-report.js";

export class Gateway {
  private sequence = 0;
  private readonly clients = new Set<WebSocket>();
  readonly coordinator: RunCoordinator;
  private readonly globalLimit: RequestLimiter;
  private readonly sessionLimits: SessionRateLimits;

  constructor(private readonly store: SessionStore, private readonly runtime: AgentRuntime, timeoutMs = 120_000,
    private readonly tools?: ToolRegistry, contextBudgetChars = 120_000, private readonly skills?: SkillRegistry,
    private readonly evaluation?: EvaluationReportReader,
    private readonly limits: GatewayLimitConfig = DEFAULT_GATEWAY_LIMITS,
    private readonly verification?: VerificationReportReader, agents?: AgentRegistry,
    private readonly debugObserver?: (event: string, payload: Record<string, unknown>) => void) {
    this.globalLimit = new RequestLimiter(limits.global);
    this.sessionLimits = new SessionRateLimits(limits.session);
    this.coordinator = new RunCoordinator(store, runtime, (run) => {
      this.debug("run.updated", { run });
      this.broadcast("run.updated", { run });
    }, timeoutMs, tools, contextBudgetChars, skills, agents);
  }

  attach(socket: WebSocket): void {
    const connectionLimit = new RequestLimiter(this.limits.connection);
    let connected = false;
    const handshakeTimer = setTimeout(() => socket.close(1008, "connect required"), 10_000);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => { clearTimeout(handshakeTimer); this.clients.delete(socket); });
    socket.on("message", (raw) => {
      let id = "";
      try {
        let value: unknown;
        try { value = JSON.parse(raw.toString()); }
        catch { throw new AppError("INVALID_JSON", "请求需要合法 JSON。"); }
        const request = parseRequest(value);
        if (!request) throw new AppError("INVALID_REQUEST", "请求格式错误。");
        id = request.id;
        this.debug("request.received", { request });
        // Stopping or rejecting a tool must remain available during request floods.
        const control = connected && (request.method === "chat.abort" ||
          request.method === "tools.decide" && request.params?.decision === "rejected");
        if (!control) { this.globalLimit.take("GATEWAY_RATE_LIMITED")(); connectionLimit.take("CONNECTION_RATE_LIMITED")(); }
        if (request.method === "connect") {
          if (connected) throw new AppError("ALREADY_CONNECTED", "连接已初始化。");
          connected = true;
          clearTimeout(handshakeTimer);
          this.clients.add(socket);
          this.respond(socket, id, { protocolVersion: 1, runtime: this.runtime.info, capabilities: this.tools?.catalog ?? [] });
          return;
        }
        if (!connected) throw new AppError("NOT_CONNECTED", "请先发送 connect。");
        this.respond(socket, id, this.handle(request.method, request.params ?? {}));
      } catch (error) {
        this.debug("request.failed", { id, code: error instanceof AppError ? error.code : "INTERNAL_ERROR" });
        this.send(socket, { type: "res", id, ok: false, error: {
          code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
          message: error instanceof AppError ? error.message : "Gateway 无法处理请求。",
          ...(error instanceof AppError && error.details ? error.details : {}),
        } });
      }
    });
  }

  private debug(event: string, payload: Record<string, unknown>): void {
    try { this.debugObserver?.(event, payload); } catch { /* Observability must not change execution. */ }
  }

  async shutdown(): Promise<void> {
    await this.coordinator.shutdown();
    for (const socket of this.clients) socket.close(1001, "Gateway shutdown");
  }

  private handle(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "skills.list": return this.skills?.overview() ?? { skills: [], error: "Skills 未配置" };
      case "skills.refresh": {
        if (!this.skills) throw new AppError("SKILLS_UNAVAILABLE", "Skills 未配置。");
        return this.skills.refresh();
      }
      case "agents.list": return this.coordinator.agentStatus();
      case "runs.children": return { runs: this.store.children(this.string(params.runId, "runId", 128)) };
      case "system.limits":
        return { gateway: this.globalLimit.snapshot(), connection: this.limits.connection,
          session: this.limits.session, model: this.runtime.limits?.() ?? null, scope: "本机进程；重启后计数重置" };
      case "verification.overview":
        return this.verification?.overview() ?? { available: false, message: "验收报告未配置。" };
      case "verification.detail":
        if (!this.verification) throw new AppError("VERIFICATION_NOT_FOUND", "验收报告未配置。");
        return this.verification.detail(this.string(params.id, "id", 128));
      case "sessions.list":
        return { sessions: this.store.list(params.includeArchived === true) };
      case "sessions.create": {
        const topicId = params.topicId === undefined ? null : this.string(params.topicId, "topicId", 64);
        const session = this.store.create(null, topicId);
        this.broadcast("sessions.changed", { session });
        return { session };
      }
      case "sessions.new": {
        const current = params.currentSessionId === undefined ? undefined : this.string(params.currentSessionId, "currentSessionId", 128);
        const session = this.store.newSession(current);
        this.broadcast("sessions.changed", { session });
        return { session };
      }
      case "sessions.reset": {
        const session = this.store.reset(this.string(params.sessionId, "sessionId", 128));
        this.broadcast("session.reset", { session });
        return { session };
      }
      case "chat.history":
        {
          const history = this.store.history(this.string(params.sessionId, "sessionId", 128));
          return { ...history, childRuns: history.runs.flatMap((run) => this.store.children(run.id)) };
        }
      case "runs.events":
        return { events: this.store.eventsForRun(this.string(params.runId, "runId", 128)) };
      case "runs.get":
        return { run: this.store.getRun(this.string(params.runId, "runId", 128)) };
      case "runs.attempts":
        return { attempts: this.store.recoveryDrafts(this.string(params.runId, "runId", 128)) };
      case "evaluation.overview":
        return this.evaluation?.overview() ?? { available: false, message: "评测报告未配置。" };
      case "evaluation.detail":
        if (!this.evaluation) throw new AppError("EVALUATION_NOT_FOUND", "评测报告未配置。");
        return this.evaluation.detail(this.string(params.id, "id", 128));
      case "chat.send": {
        const sessionId = this.string(params.sessionId, "sessionId", 128);
        const clientRequestId = this.string(params.clientRequestId, "clientRequestId", 128);
        const content = this.string(params.content, "content", 32_000);
        this.store.get(sessionId);
        if (!this.store.findRequest(sessionId, clientRequestId)) this.sessionLimits.take(sessionId);
        return { run: this.coordinator.accept(sessionId, clientRequestId, content) };
      }
      case "chat.steer": {
        const runId = this.string(params.runId, "runId", 128);
        const clientRequestId = this.string(params.clientRequestId, "clientRequestId", 128);
        const content = this.string(params.content, "content", 32_000);
        const current = this.store.getRun(runId);
        if (!JSON.parse(current.steerTrace).some((entry: { clientRequestId: string }) => entry.clientRequestId === clientRequestId)) {
          this.sessionLimits.take(current.sessionId);
        }
        return { run: this.coordinator.steer(runId, clientRequestId, content) };
      }
      case "chat.abort":
        return { run: this.coordinator.cancel(this.string(params.runId, "runId", 128)) };
      case "tools.decide": {
        const decision = this.string(params.decision, "decision", 16);
        if (decision !== "approved" && decision !== "rejected") {
          throw new AppError("INVALID_PARAMS", "decision 只能是 approved 或 rejected。");
        }
        return { run: this.coordinator.decideTool(
          this.string(params.runId, "runId", 128), this.string(params.toolCallId, "toolCallId", 128), decision,
        ) };
      }
      default: throw new AppError("METHOD_NOT_FOUND", `不支持的方法：${method}`);
    }
  }

  private string(value: unknown, field: string, maximum: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      throw new AppError("INVALID_PARAMS", `${field} 必须是非空字符串，最多 ${maximum} 个字符。`);
    }
    return value;
  }

  private broadcast(event: string, payload: Record<string, unknown>): void {
    const frame: GatewayEvent = { type: "event", event, payload, seq: ++this.sequence };
    for (const socket of this.clients) this.send(socket, frame);
  }

  private respond(socket: WebSocket, id: string, payload: unknown): void {
    this.send(socket, { type: "res", id, ok: true, payload });
  }

  private send(socket: WebSocket, frame: GatewayResponse | GatewayEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2_000_000) { socket.close(1013, "Client too slow; reconnect"); return; }
    socket.send(JSON.stringify(frame));
  }
}
