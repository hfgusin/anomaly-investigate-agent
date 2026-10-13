import test from "node:test";
import assert from "node:assert/strict";
import { ChatCompletionsRuntime } from "../dist/providers/chat-completions.js";
import { readConfig } from "../dist/config.js";

const config = { baseUrl: "https://provider.example/v1", model: "chosen-model", apiKey: "private-test-key" };
const input = { messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal };
function response(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) { for (let n = 0; n < bytes.length; n += 2) controller.enqueue(bytes.slice(n, n + 2)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}
const frame = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
async function collect(runtime) { let result = ""; for await (const chunk of runtime.stream(input)) result += chunk; return result; }

test("Chat Completions handles split UTF-8/SSE frames and sends the selected model", async () => {
  let sent;
  const runtime = new ChatCompletionsRuntime(config, async (url, init) => {
    sent = { url: String(url), ...init };
    return response(frame({ role: "assistant" }) + frame({ content: "你好" }) + frame({}, "stop") + "data: [DONE]\r\n\r\n");
  });
  assert.equal(await collect(runtime), "你好");
  assert.equal(sent.url, "https://provider.example/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer private-test-key");
  const body = JSON.parse(sent.body);
  assert.equal(body.model, config.model);
  assert.equal(body.stream, true);
  assert.doesNotMatch(body.messages[0].content, /用户拒绝调用/);
});

test("null tool_calls on a text-only response is not a tool request", async () => {
  const sse = new ChatCompletionsRuntime(config, async () => response(
    frame({ content: "记忆", tool_calls: null }) + frame({ tool_calls: [] }, "stop") + frame({ tool_calls: [] }, "stop")));
  assert.equal(await collect(sse), "记忆");
  const json = new ChatCompletionsRuntime(config, async () => new Response(JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "记忆", tool_calls: [] }, finish_reason: "stop" }],
  }), { headers: { "content-type": "application/json" } }));
  assert.equal(await collect(json), "记忆");
});

test("tool-capable requests tell the model how to describe a rejected approval", async () => {
  let sent;
  const runtime = new ChatCompletionsRuntime(config, async (_url, init) => {
    sent = JSON.parse(init.body);
    return response(frame({ content: "ok" }) + frame({}, "stop"));
  });
  const toolInput = { ...input, callTool: async () => ({ content: "unused", isError: false }), toolDefinitions: [] };
  for await (const _chunk of runtime.stream(toolInput)) { /* consume */ }
  assert.match(sent.messages[0].content, /用户拒绝调用/);
  assert.match(sent.messages[0].content, /不要把拒绝误说成未找到数据/);
});

test("tool results cannot exceed the reserved context space", async () => {
  const toolCall = frame({ tool_calls: [{ index: 0, id: "call_budget", type: "function",
    function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }] }) + frame({}, "tool_calls");
  const runtime = new ChatCompletionsRuntime(config, async () => response(toolCall));
  await assert.rejects(async () => {
    for await (const _chunk of runtime.stream({ ...input, toolDefinitions: [{ type: "function" }],
      maxToolResultChars: 3, callTool: async () => ({ content: "larger than reserved", isError: false }) })) { /* consume */ }
  }, { code: "TOOL_CONTEXT_TOO_LARGE" });
});

test("truncated streams and length finish reasons are never reported as completed", async () => {
  for (const text of [frame({ content: "partial" }), frame({ content: "partial" }, "length"), frame({ content: "partial" }) + "data: [DONE]\n\n"]) {
    const runtime = new ChatCompletionsRuntime(config, async () => response(text));
    const chunks = [];
    await assert.rejects(async () => { for await (const delta of runtime.stream(input)) chunks.push(delta); });
    assert.deepEqual(chunks, ["partial"]);
  }
});

test("provider HTTP failure does not disclose the body or credentials", async () => {
  const runtime = new ChatCompletionsRuntime(config, async () => new Response("private-test-key", { status: 401 }));
  await assert.rejects(collect(runtime), (error) => error.code === "PROVIDER_HTTP_ERROR" &&
    error.message.includes("401") && !error.message.includes(config.apiKey));
});

test("transport and response stream errors do not expose provider secrets or diagnostic bodies", async (t) => {
  const failures = [];
  for (const request of [async () => { throw new Error(`connection failed: Bearer ${config.apiKey}`); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(config.apiKey)); } }),
      { headers: { "content-type": "text/event-stream" } })]) {
    const runtime = new ChatCompletionsRuntime(config, request);
    await assert.rejects(collect(runtime), (error) => {
      failures.push({ code: error.code, message: error.message, credentialExposed: error.message.includes(config.apiKey) });
      return error.code === "PROVIDER_TRANSPORT_ERROR" && !error.message.includes(config.apiKey) && !error.cause;
    });
    assert.equal(runtime.limits().active, 0);
  }
  t.diagnostic(JSON.stringify({ kind: "acceptance-evidence", name: t.name,
    input: "fixture errors containing a synthetic credential", config: { faults: ["fetch rejection", "response stream failure"] },
    expected: { code: "PROVIDER_TRANSPORT_ERROR", credentialExposed: false, active: 0 },
    actual: { failures },
    trace: failures }));
});

test("missing Content-Type still accepts an event-first SSE response", async () => {
  const runtime = new ChatCompletionsRuntime(config, async () => new Response(new TextEncoder().encode(
    "event: message\n" + frame({ content: "answer" }) + frame({}, "stop") + "data: [DONE]\n\n")));
  assert.equal(await collect(runtime), "answer");
});

test("plain tool follow-up keeps the selected skill instruction", async () => {
  const requests = [];
  const runtime = new ChatCompletionsRuntime({ ...config, toolResultMode: "plain" }, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response(requests.length === 1
      ? frame({ tool_calls: [{ index: 0, id: "research", type: "function",
        function: { name: "research_hotpot", arguments: '{"question":"q"}' } }] }) + frame({}, "tool_calls")
      : frame({ content: "答案：ok" }) + frame({}, "stop"));
  });
  let output = "";
  for await (const chunk of runtime.stream({ ...input, skillInstruction: "CITE_EXACT_SENTENCE_IDS",
    toolDefinitions: [{ type: "function" }], callTool: async () => ({ content: "evidence", isError: false }) })) {
    if (typeof chunk === "string") output += chunk;
  }
  assert.equal(output, "答案：ok");
  assert.match(requests[0].messages[0].content, /CITE_EXACT_SENTENCE_IDS/u);
  assert.match(requests[1].messages[0].content, /CITE_EXACT_SENTENCE_IDS/u);
});

test("compatible provider may send provisional stop with tool fragments before tool_calls", async () => {
  const requests = [];
  const runtime = new ChatCompletionsRuntime({ ...config, toolResultMode: "plain" }, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response(requests.length === 1
      ? frame({ content: "<tool_call>", tool_calls: [{ index: 0, id: "call_1", type: "function",
        function: { name: "research_hotpot", arguments: '{"question":"q"}' } }] }, "stop") + frame({}, "tool_calls")
      : frame({ content: "答案：ok" }) + frame({}, "stop"));
  });
  let output = ""; let calls = 0;
  for await (const chunk of runtime.stream({ ...input, toolDefinitions: [{ type: "function" }],
    callTool: async () => { calls++; return { content: "evidence", isError: false }; } })) {
    if (typeof chunk === "string") output += chunk;
    else output = output.slice(0, -chunk.chars);
  }
  assert.equal(calls, 1);
  assert.equal(output, "答案：ok");
});

test("invalid provider configuration fails explicitly rather than silently entering demo mode", () => {
  assert.throws(() => readConfig({ MIRROR_RUNTIME: "chat-completions" }, "/tmp"), { code: "INVALID_CONFIG" });
  assert.throws(() => new ChatCompletionsRuntime({ ...config, baseUrl: "http://external.example/v1" }), { code: "INVALID_CONFIG" });
  assert.equal(readConfig({}, process.cwd()).runtime.info.kind, "demo");
});
