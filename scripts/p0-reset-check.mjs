import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const url = process.env.P0_GATEWAY_URL ?? "ws://127.0.0.1:18789/gateway";
const socket = new WebSocket(url);
const pending = new Map();
socket.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type !== "res") return;
  const target = pending.get(frame.id);
  if (!target) return;
  pending.delete(frame.id);
  clearTimeout(target.timer);
  frame.ok ? target.resolve(frame.payload) : target.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
});

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

async function complete(sessionId, content) {
  const { run } = await request("chat.send", { sessionId, content, clientRequestId: randomUUID() });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const history = await request("chat.history", { sessionId });
    const latest = history.runs.find((item) => item.id === run.id);
    if (latest && !["queued", "running"].includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run ${run.id} did not finish`);
}

try {
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await request("connect");
  const { session } = await request("sessions.create");
  const marker = `RESETMARK-${randomUUID().slice(0, 8)}`;
  const before = await complete(session.id, `请记住当前会话的随机标记 ${marker}。只回复“已记住”。`);
  assert.equal(before.status, "completed");
  const confirmed = await complete(session.id, "当前会话的随机标记是什么？只输出标记本身。");
  assert.equal(confirmed.status, "completed");
  assert.ok(confirmed.output.includes(marker), `模型重置前未复述标记：${confirmed.output}`);
  const reset = await request("sessions.reset", { sessionId: session.id });
  assert.equal(reset.session.id, session.id);
  assert.equal(reset.session.generation, session.generation + 1);
  assert.equal((await request("chat.history", { sessionId: session.id })).runs.length, 0);
  const after = await complete(session.id, "当前会话的随机标记是什么？如果本轮对话没有给出，请只回复“当前会话没有标记”。");
  assert.equal(after.status, "completed");
  assert.ok(!after.output.includes(marker), `重置后泄露了旧标记：${after.output}`);
  console.log(JSON.stringify({ scenario: "P0-4", status: "passed", sessionId: session.id,
    generation: reset.session.generation, beforeRunId: confirmed.id, afterRunId: after.id,
    beforeAnswer: confirmed.output, afterAnswer: after.output }));
} catch (error) {
  console.error(JSON.stringify({ scenario: "P0-4", status: "failed", error: error.message }));
  process.exitCode = 1;
} finally {
  socket.close();
}
