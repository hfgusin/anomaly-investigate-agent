import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { SessionStore } from "../dist/session-store.js";

const root = resolve(import.meta.dirname, "..");
const record = JSON.parse(readFileSync(resolve(root, "data/hotpotqa/validation-sample.json"), "utf8"))[0];
const outputPath = resolve(process.argv[2] || resolve(root, ".data/hotpotqa/resume-live-check.json"));
const port = Number(process.env.RESUME_SMOKE_PORT || 18791);
const directory = mkdtempSync(join(tmpdir(), "research-resume-live-"));
const children = [];
let firstSocket;
let secondSocket;

async function boot() {
  const child = spawn(process.execPath, ["dist/server.js"], { cwd: root,
    env: { ...process.env, PORT: String(port), MIRROR_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for await (const line of lines) {
    if (!line.startsWith("OpenClaw Mirror:")) continue;
    lines.close();
    return child;
  }
  throw new Error(`Gateway did not start: ${stderr.slice(0, 500)}`);
}

async function connect(onRun) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
  await once(socket, "open");
  const pending = new Map();
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "res") {
      const task = pending.get(frame.id);
      if (task) { pending.delete(frame.id); frame.ok ? task.resolve(frame.payload) : task.reject(new Error(frame.error.message)); }
    } else if (frame.type === "event" && frame.event === "run.updated") onRun(frame.payload.run, request);
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }
  await request("connect");
  return { socket, request };
}

async function stop(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

async function withTimeout(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]); }
  finally { clearTimeout(timer); }
}

try {
  const first = await boot();
  let runId;
  let sessionId;
  const approved = new Set();
  let firstToolDone;
  const firstTool = new Promise((resolve) => { firstToolDone = resolve; });
  firstSocket = await connect((run, request) => {
    if (run.id !== runId) return;
    for (const call of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) {
      if (approved.has(call.id)) continue;
      approved.add(call.id);
      void request("tools.decide", { runId, toolCallId: call.id, decision: "approved" });
    }
    if (JSON.parse(run.toolTrace).some((call) => call.status === "completed")) firstToolDone(run);
  });
  sessionId = (await firstSocket.request("sessions.create")).session.id;
  runId = (await firstSocket.request("chat.send", { sessionId, clientRequestId: randomUUID(),
    content: `/research2 ${record.question}` })).run.id;
  const checkpointBeforeCrash = await withTimeout(firstTool, 90_000, "首次工具调用未在时限内完成。");
  await stop(first, "SIGKILL");
  firstSocket.socket.close();

  const second = await boot();
  const approvedAfterRestart = new Set();
  let finish;
  const terminal = new Promise((resolve) => { finish = resolve; });
  secondSocket = await connect((run, request) => {
    if (run.id !== runId) return;
    for (const call of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) {
      if (approvedAfterRestart.has(call.id)) continue;
      approvedAfterRestart.add(call.id);
      void request("tools.decide", { runId, toolCallId: call.id, decision: "approved" });
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) finish(run);
  });
  const history = await secondSocket.request("chat.history", { sessionId });
  const current = history.runs.find((run) => run.id === runId);
  for (const call of JSON.parse(current.toolTrace).filter((item) => item.status === "requested")) {
    approvedAfterRestart.add(call.id);
    await secondSocket.request("tools.decide", { runId, toolCallId: call.id, decision: "approved" });
  }
  if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) finish(current);
  const finished = await withTimeout(terminal, 130_000, "恢复后的 Run 未在时限内结束。");
  await stop(second, "SIGTERM");
  secondSocket.socket.close();
  const store = new SessionStore(join(directory, "gateway.sqlite"));
  const events = store.eventsForRun(runId);
  const drafts = store.recoveryDrafts(runId);
  store.close();
  const report = { question: record.question, runId, status: finished.status, output: finished.output,
    error: finished.error, checkpointBeforeCrash: JSON.parse(checkpointBeforeCrash.checkpoint),
    finalCheckpoint: JSON.parse(finished.checkpoint), recoveryDrafts: drafts,
    calls: JSON.parse(finished.toolTrace), events: events.map((event) => ({ seq: event.seq, type: event.type, payload: JSON.parse(event.payload) })) };
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, status: report.status, recoveryAttempts: drafts.length,
    completedCalls: report.calls.filter((call) => call.status === "completed").length,
    eventTypes: report.events.map((event) => event.type), output: report.output }, null, 2));
  if (finished.status !== "completed") process.exitCode = 1;
} finally {
  firstSocket?.socket.close(); secondSocket?.socket.close();
  for (const child of children) await stop(child, "SIGKILL");
  rmSync(directory, { recursive: true, force: true });
}
