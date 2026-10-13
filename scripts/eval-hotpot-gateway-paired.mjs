import { createHash, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { SessionStore } from "../dist/session-store.js";
import { ToolRegistry } from "../dist/tools/read-file.js";
import { SkillRegistry } from "../dist/skills.js";
import { createApplication } from "../dist/server.js";
import { scoreModelOutput } from "./hotpot-live-runner.mjs";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) loadEnvFile(resolve(root, ".env"));
if (!process.env.MODEL_BASE_URL || !process.env.MODEL_NAME) throw new Error(".env 缺少模型接口配置。");
const dataPath = resolve(process.env.HOTPOTQA_DATA_FILE || resolve(root, ".data/hotpotqa/validation.json"));
const outputPath = resolve(process.argv[2] || resolve(root, ".data/hotpotqa/gateway-paired-2026-09-30.json"));
const limit = Number(process.argv[3] || 10);
if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("开发诊断题数必须为 1–10。");
const dataBytes = readFileSync(dataPath);
const records = new Map(JSON.parse(dataBytes.toString("utf8")).map((record) => [record.id, record]));
const ids = readdirSync(resolve(root, ".data/hotpotqa"))
  .filter((name) => /^v2-current-[a-f0-9]+\.json$/u.test(name))
  .map((name) => name.slice("v2-current-".length, -".json".length)).sort();
if (ids.length !== 10 || ids.some((id) => !records.has(id))) {
  throw new Error("固定开发题集不完整：预期找到 10 个 v2-current 记录及其 HotpotQA 原题。");
}
const selected = ids.slice(0, limit);
const temp = mkdtempSync(join(tmpdir(), "hotpot-gateway-paired-"));
const store = new SessionStore(join(temp, "gateway.sqlite"));
const tools = new ToolRegistry(join(temp, "workspace"), dataPath);
const runtime = new ChatCompletionsRuntime({ baseUrl: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME,
  apiKey: process.env.MODEL_API_KEY || "", toolResultMode: process.env.MODEL_TOOL_RESULT_MODE === "plain" ? "plain" : "standard" });
const application = await createApplication(store, runtime, 120_000, tools, 120_000, new SkillRegistry(root));
const report = { scope: "fixed 10 development questions; Gateway path with model and auto-approved read-only research calls",
  model: process.env.MODEL_NAME, toolResultMode: process.env.MODEL_TOOL_RESULT_MODE === "plain" ? "plain (research2 overrides standard)" : "standard",
  dataSha256: createHash("sha256").update(dataBytes).digest("hex"),
  ids: selected, startedAt: new Date().toISOString(), runs: [], summary: null };
let socket;

function summarize() {
  const byMode = Object.fromEntries(["research", "research2"].map((mode) => {
    const runs = report.runs.filter((run) => run.mode === mode);
    const accepted = runs.filter((run) => run.status === "completed");
    const mean = (field) => runs.length ? runs.reduce((total, run) => total +
      (run.status === "completed" ? run.score[field] : 0), 0) / runs.length : 0;
    return [mode, { attempted: runs.length, completed: runs.filter((run) => run.status === "completed").length,
      answerEM: accepted.filter((run) => run.score.answerEM).length, meanAnswerF1: mean("answerF1"),
      supportEM: accepted.filter((run) => run.score.supportEM).length, meanSupportF1: mean("supportF1"),
      jointEM: accepted.filter((run) => run.score.jointEM).length, meanJointF1: mean("jointF1"),
      citationInvalid: runs.filter((run) => run.unsupportedCitations.length).length,
      citationValidationFailures: runs.filter((run) => run.status === "failed" && /研究回答/u.test(run.error || "")).length,
      toolErrors: runs.reduce((total, run) => total + run.calls.filter((call) => call.status === "failed").length, 0),
      repairs: runs.filter((run) => run.repair?.attempted).length,
      repairSuccesses: runs.filter((run) => run.repair?.succeeded).length,
      meanDurationMs: runs.length ? Math.round(runs.reduce((total, run) => total + run.durationMs, 0) / runs.length) : 0 }];
  }));
  return byMode;
}

try {
  await new Promise((done, reject) => application.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : done()));
  const address = application.server.address();
  socket = new WebSocket(`ws://127.0.0.1:${address.port}/gateway`);
  await once(socket, "open");
  const pending = new Map();
  const active = new Map();
  const approved = new Set();
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "res") {
      const item = pending.get(frame.id);
      if (item) { pending.delete(frame.id); frame.ok ? item.resolve(frame.payload) : item.reject(new Error(frame.error.message)); }
      return;
    }
    if (frame.type !== "event" || frame.event !== "run.updated") return;
    const run = frame.payload.run;
    const task = active.get(run.sessionId);
    if (!task) return;
    for (const call of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) {
      if (approved.has(call.id)) continue;
      approved.add(call.id);
      if (!["research_hotpot", "search_passages", "open_passage"].includes(call.name)) {
        task.reject(new Error(`未预期的工具：${call.name}`));
        return;
      }
      void request("tools.decide", { runId: run.id, toolCallId: call.id, decision: "approved" })
        .catch(task.reject);
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      active.delete(run.sessionId);
      task.resolve(run);
    }
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }
  await request("connect");
  for (const [index, id] of selected.entries()) {
    const record = records.get(id);
    const order = index % 2 === 0 ? ["research", "research2"] : ["research2", "research"];
    for (const mode of order) {
      const sessionId = (await request("sessions.create")).session.id;
      const terminal = new Promise((resolve, reject) => active.set(sessionId, { resolve, reject }));
      const started = Date.now();
      await request("chat.send", { sessionId, clientRequestId: randomUUID(), content: `/${mode} ${record.question}` });
      let deadline;
      const run = await Promise.race([terminal, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Run 超时：${id} ${mode}`)), 130_000);
      })]).finally(() => clearTimeout(deadline));
      const calls = JSON.parse(run.toolTrace);
      const contextTrace = JSON.parse(run.contextTrace);
      const evidence = mode === "research" ? calls.filter((call) => call.name === "research_hotpot" && call.result)
        .flatMap((call) => JSON.parse(call.result).evidence || [])
        : calls.filter((call) => call.name === "open_passage" && call.status === "completed" && call.result)
          .map((call) => JSON.parse(call.result));
      const scored = scoreModelOutput(record, run.output, { evidence });
      const repair = contextTrace.researchRepair || null;
      const initial = repair?.initialOutput ? scoreModelOutput(record, repair.initialOutput, { evidence }) : null;
      report.runs.push({ id, mode, status: run.status, error: run.error, durationMs: Date.now() - started,
        output: run.output, calls, repair, initialScore: initial?.score || null,
        answerExtracted: scored.answerExtracted, formatValid: scored.formatValid,
        citations: scored.citations, unsupportedCitations: scored.unsupportedCitations, score: scored.score });
      report.summary = summarize();
      writeFileSync(outputPath, JSON.stringify(report, null, 2));
      process.stderr.write(`${report.runs.length}/${selected.length * 2} ${id} ${mode} ${run.status} joint=${scored.score.jointEM} repair=${Boolean(repair?.attempted)}\n`);
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, dataSha256: report.dataSha256, summary: report.summary }, null, 2));
} finally {
  socket?.close();
  await application.close();
  store.close();
  rmSync(temp, { recursive: true, force: true });
}
