import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.P0_MODEL_PORT ?? 19041);
const markerPattern = /P0MARK-[a-z0-9]+/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
  return "";
}

function answer(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const users = messages.filter((message) => message.role === "user").map((message) => contentText(message.content));
  const lastUser = users.at(-1) ?? "";
  const current = [...users].reverse().find((text) =>
    /P0MARK-|标记是什么|P0-READ|P0-SLOW|P0-A1|P0-A2|P0-B1/u.test(text)) ?? lastUser;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const read = tools.find((tool) => ["read", "read_file"].includes(tool?.function?.name));
  if (messages.some((message) => message.role === "tool")) return { text: "Cedar-731" };
  if (messages.length > 30) return { text: "P0 fixture loop stopped" };
  if (current.includes("P0-READ") && read) {
    const properties = read.function?.parameters?.properties ?? {};
    const key = "file_path" in properties ? "file_path" : "path";
    return { toolCall: { name: read.function.name, arguments: JSON.stringify({ [key]: "agent_demo.txt" }) } };
  }
  if (current.includes("P0-SLOW")) return { text: "片段".repeat(100), slow: true };
  if (current.includes("P0-A1")) return { text: `A1 ${"片段".repeat(100)} 完成`, slow: true };
  if (current.includes("P0-A2")) return { text: "A2 完成" };
  if (current.includes("P0-B1")) return { text: "B1 完成" };
  if (current.includes("标记是什么")) {
    const prior = users.slice(0, users.lastIndexOf(current)).join("\n").match(markerPattern)?.[0];
    return { text: prior ?? "当前会话没有标记" };
  }
  if (markerPattern.test(current)) return { text: "已记住" };
  if (current.includes("标记")) return { text: "当前会话没有标记" };
  return { text: "OK" };
}

function chunk(id, model, delta, finishReason = null) {
  return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end(); return;
  }
  let raw = "";
  for await (const part of request) {
    raw += part.toString();
    if (raw.length > 5_000_000) { response.writeHead(413).end(); return; }
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { response.writeHead(400).end(); return; }
  const result = answer(body);
  const id = `chatcmpl-p0-${randomUUID()}`;
  const model = body.model ?? "p0-fixture";
  const roles = (body.messages ?? []).map((message) => message.role);
  process.stdout.write(JSON.stringify({ event: "request", lastRoles: roles.slice(-5), tool: result.toolCall?.name ?? null,
    slow: Boolean(result.slow), messageCount: roles.length, toolCount: roles.filter((role) => role === "tool").length,
    hasMarker: roles.some((role, index) => role === "user" && markerPattern.test(contentText(body.messages[index].content))) }) + "\n");
  if (!body.stream) {
    const message = result.toolCall ? { role: "assistant", content: null, tool_calls: [{ id: `call_${randomUUID()}`,
      type: "function", function: result.toolCall }] } : { role: "assistant", content: result.text };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message, finish_reason: result.toolCall ? "tool_calls" : "stop" }] }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  send(chunk(id, model, { role: "assistant" }));
  if (result.toolCall) {
    send(chunk(id, model, { tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function",
      function: result.toolCall }] }));
    send(chunk(id, model, {}, "tool_calls"));
  } else {
    const pieces = result.slow ? result.text.match(/.{1,2}/gu) ?? [] : [result.text];
    for (const piece of pieces) {
      if (response.destroyed) return;
      send(chunk(id, model, { content: piece }));
      if (result.slow) await sleep(100);
    }
    send(chunk(id, model, {}, "stop"));
  }
  response.end("data: [DONE]\n\n");
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`P0 model fixture listening on ${port}\n`));
