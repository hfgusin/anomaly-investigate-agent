#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createInterface } from "node:readline/promises";

const usage = `用法：
  pnpm mirror sessions
  pnpm mirror create
  pnpm mirror new <父会话 ID>
  pnpm mirror reset <会话 ID>
  pnpm mirror send <会话 ID> <消息>
  pnpm mirror stop <Run ID>
  pnpm mirror approve <Run ID> <工具调用 ID>
  pnpm mirror deny <Run ID> <工具调用 ID>
  pnpm mirror inspect <Run ID>

默认连接 ws://127.0.0.1:18789/gateway；自定义端口可设置 MIRROR_GATEWAY_URL。`;
const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);

function gatewayUrl() {
  const url = new URL(process.env.MIRROR_GATEWAY_URL ?? "ws://127.0.0.1:18789/gateway");
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/gateway") {
    throw new Error("CLI 目前只连接本机 Gateway 的 ws://127.0.0.1:<端口>/gateway。");
  }
  return url.toString();
}

async function connect(url) {
  const socket = new WebSocket(url, { handshakeTimeout: 5000 });
  const pending = new Map();
  const runs = new Map();
  const waiters = new Set();
  let revision = 0;
  let closed = false;
  socket.on("error", () => {});
  socket.on("message", (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (frame.type === "res") {
      const item = pending.get(frame.id);
      if (!item) return;
      pending.delete(frame.id); clearTimeout(item.timer);
      frame.ok ? item.resolve(frame.payload) : item.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
    } else if (frame.type === "event" && frame.event === "run.updated") {
      const run = frame.payload.run;
      const previous = runs.get(run.id);
      if (!previous || run.version > previous.version) runs.set(run.id, run);
      revision++;
      for (const wake of waiters) wake();
      waiters.clear();
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Gateway 连接已断开。")); }
    pending.clear();
    for (const wake of waiters) wake();
    waiters.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 Gateway 超时。")), 5000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  function request(method, params = {}) {
    if (closed) return Promise.reject(new Error("Gateway 连接已断开。"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 请求超时。`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }
  await request("connect");
  return { request, runs, close: () => socket.close(), revision: () => revision,
    waitChange: (seen) => revision !== seen || closed ? Promise.resolve() : new Promise((resolve) => waiters.add(resolve)),
    isClosed: () => closed };
}

async function send(client, sessionId, content) {
  const { run: accepted } = await client.request("chat.send", { sessionId, content, clientRequestId: randomUUID() });
  process.stderr.write(`Run ${accepted.id} 已接收\n`);
  let shown = "";
  const prompted = new Set();
  const input = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  try {
    for (;;) {
      const seen = client.revision();
      const current = client.runs.get(accepted.id) ?? accepted;
      const run = current.version > accepted.version ? current : accepted;
      if (run.output !== shown) {
        if (run.output.startsWith(shown)) process.stdout.write(run.output.slice(shown.length));
        else process.stdout.write(`\n[输出已重新生成]\n${run.output}`);
        shown = run.output;
      }
      if (terminal.has(run.status)) {
        if (shown && !shown.endsWith("\n")) process.stdout.write("\n");
        process.stderr.write(`Run ${run.id}：${run.status}${run.error ? ` · ${run.error}` : ""}\n`);
        return run.status === "completed" ? 0 : 1;
      }
      const calls = JSON.parse(run.toolTrace || "[]");
      for (const call of calls.filter((item) => item.status === "requested" && !prompted.has(item.id))) {
        prompted.add(call.id);
        if (!input) {
          process.stderr.write(`工具待审批：${call.name}(${call.arguments})\n执行 pnpm mirror approve ${run.id} ${call.id} 或 pnpm mirror deny ${run.id} ${call.id}\n`);
          return 2;
        }
        const answer = (await input.question(`允许 ${call.name}(${call.arguments})？输入 yes 批准，其余拒绝：`)).trim().toLowerCase();
        try {
          await client.request("tools.decide", { runId: run.id, toolCallId: call.id,
            decision: answer === "yes" ? "approved" : "rejected" });
        } catch (error) {
          if (!String(error.message).includes("TOOL_NOT_PENDING")) throw error;
        }
      }
      if (client.isClosed()) throw new Error("Gateway 连接已断开；已接收的 Run 可在页面中继续查看。");
      await client.waitChange(seen);
    }
  } finally { input?.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") { process.stdout.write(`${usage}\n`); return 0; }
  const counts = { sessions: 0, create: 0, new: 1, reset: 1, send: 2, stop: 1, approve: 2, deny: 2, inspect: 1 };
  if (!(command in counts) || args.length < counts[command]) throw new Error(usage);
  const client = await connect(gatewayUrl());
  try {
    if (command === "sessions") {
      const { sessions } = await client.request("sessions.list", { includeArchived: true });
      for (const session of sessions) process.stdout.write(`${session.id}\t${session.archived ? "归档" : "可用"}\t${session.title}\n`);
    } else if (command === "create") {
      const { session } = await client.request("sessions.create"); process.stdout.write(`${session.id}\n`);
    } else if (command === "new") {
      const { session } = await client.request("sessions.new", { currentSessionId: args[0] });
      process.stdout.write(`${session.id}\n`);
    } else if (command === "reset") {
      const { session } = await client.request("sessions.reset", { sessionId: args[0] });
      process.stdout.write(`${session.id}\t已重置到第 ${session.generation} 代\n`);
    } else if (command === "send") {
      return await send(client, args[0], args.slice(1).join(" "));
    } else if (command === "stop") {
      const { run } = await client.request("chat.abort", { runId: args[0] });
      process.stdout.write(`${run.id}\t${run.status}\n`);
    } else if (command === "approve" || command === "deny") {
      const { run } = await client.request("tools.decide", { runId: args[0], toolCallId: args[1],
        decision: command === "approve" ? "approved" : "rejected" });
      process.stdout.write(`${run.id}\t${run.status}\n`);
    } else if (command === "inspect") {
      const [{ run }, { events }, { attempts }] = await Promise.all([
        client.request("runs.get", { runId: args[0] }), client.request("runs.events", { runId: args[0] }),
        client.request("runs.attempts", { runId: args[0] }),
      ]);
      process.stdout.write(`${JSON.stringify({ run, events, attempts }, null, 2)}\n`);
    }
    return 0;
  } finally { client.close(); }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
