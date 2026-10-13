import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { WebSocket } from "ws";

const question = process.argv[2] || "What film directed by David Greene did Merrell Jackson play an apostle in?";
const outputPath = resolve(process.argv[3] || ".data/hotpotqa/v2-gateway-check.json");
const socket = new WebSocket("ws://127.0.0.1:18789/gateway");
const pending = new Map();
const decisions = new Set();
let sessionId;
let finish;
const terminal = new Promise((resolve) => { finish = resolve; });
socket.on("message", (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.type === "res") {
    const target = pending.get(frame.id);
    if (target) { pending.delete(frame.id); frame.ok ? target.resolve(frame.payload) : target.reject(new Error(frame.error.message)); }
    return;
  }
  if (frame.type !== "event" || frame.event !== "run.updated") return;
  const run = frame.payload.run;
  if (run.sessionId !== sessionId) return;
  for (const call of JSON.parse(run.toolTrace).filter((item) => item.status === "requested")) {
    if (decisions.has(call.id)) continue;
    decisions.add(call.id);
    void request("tools.decide", { runId: run.id, toolCallId: call.id, decision: "approved" })
      .catch((error) => process.stderr.write(`工具审批失败：${error.message}\n`));
  }
  if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) finish(run);
});
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

try {
  await once(socket, "open");
  await request("connect");
  sessionId = (await request("sessions.create")).session.id;
  await request("chat.send", { sessionId, clientRequestId: randomUUID(), content: `/research2 ${question}` });
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Gateway Run 超时。")), 130_000); });
  const run = await Promise.race([terminal, deadline]).finally(() => clearTimeout(timeout));
  const calls = JSON.parse(run.toolTrace);
  writeFileSync(outputPath, JSON.stringify({ sessionId, runId: run.id, status: run.status,
    output: run.output, error: run.error, calls, contextTrace: JSON.parse(run.contextTrace) }, null, 2));
  console.log(JSON.stringify({ outputPath, status: run.status, output: run.output,
    calls: calls.map((call) => ({ name: call.name, status: call.status })) }, null, 2));
  if (run.status !== "completed") process.exitCode = 1;
} finally { socket.close(); }
