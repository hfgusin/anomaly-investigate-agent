import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { SessionStore } from "../dist/session-store.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { SkillRegistry } from "../dist/skills.js";

async function runWith(router, input, tools) {
  const store = new SessionStore(":memory:"); let captured; const seen = [];
  const runtime = { info: { kind: "responses", model: "fixture", label: "fixture" }, async *stream(request) {
    captured = request; yield "ok";
  } };
  const coordinator = new RunCoordinator(store, runtime, () => {}, 1000, tools, 120000, new SkillRegistry(resolve(".")));
  coordinator.setRouter(async (text) => { seen.push(text); return router(text); });
  try {
    const session = store.create();
    coordinator.accept(session.id, "route", input);
    const end = Date.now() + 3000;
    while (store.history(session.id).runs[0]?.status !== "completed" && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    const run = store.history(session.id).runs[0];
    assert.equal(run.status, "completed", run.error);
    return { captured, seen, run: store.getRun(run.id) };
  } finally { await coordinator.shutdown(); store.close(); }
}

test("intent router selects a Skill for natural language and records the route", async () => {
  const { captured, run } = await runWith(async () => ({ route: "daily-check", reason: "提到失败任务" }), "今天有失败的任务吗");
  assert.match(captured.skillInstruction, /每日自动化失败排查/);
  assert.equal(JSON.parse(run.skillSnapshot).id, "daily-check");
  assert.deepEqual(JSON.parse(run.providerTrace)[0], { event: "intent.route", payload: { route: "daily-check", reason: "提到失败任务" } });
});

test("clarify route asks the router's question without a Skill", async () => {
  const { captured, run } = await runWith(async () => ({ route: "clarify", reason: "缺对象", question: "排查哪个任务？" }), "帮我看看");
  assert.match(captured.skillInstruction, /不要调用工具，直接问用户：排查哪个任务？/);
  assert.equal(JSON.parse(run.skillSnapshot), null);
});

test("intent graph parameters and relevance judgments are retained in the run trace", async () => {
  const trace = [
    { node: "generate_query_or_respond", tool: "retrieve_examples", args: { query: "DAG 失败日志" } },
    { node: "grade_documents", relevant: false, reason: "样例属于其他业务" },
    { node: "rewrite_question", query: "Airflow task traceback" },
  ];
  const { run } = await runWith(async () => ({ route: "daily-check", reason: "失败排查", trace }), "昨天的 DAG 失败了");
  assert.deepEqual(JSON.parse(run.providerTrace)[0].payload.trace, trace);
});

test("source lookup loads its Skill for natural language and explicit commands", async () => {
  const natural = await runWith(async () => ({ route: "source-lookup", reason: "查业务来源" }), "渠道开启应该查哪里");
  assert.equal(JSON.parse(natural.run.skillSnapshot).id, "source-lookup");
  assert.match(natural.captured.skillInstruction, /search_business_sources/);
  assert.equal(natural.captured.toolResultMode, "standard");
  const slash = await runWith(async () => { throw Error("must skip"); }, "/source-lookup PHLOCAL 查哪里");
  assert.deepEqual(slash.seen, []);
  assert.equal(JSON.parse(slash.run.skillSnapshot).id, "source-lookup");
});

test("router failure falls back to general mode; slash commands skip the router", async () => {
  const failed = await runWith(async () => { throw new Error("timeout"); }, "你好");
  assert.equal(failed.captured.skillInstruction, undefined);
  const slash = await runWith(async () => ({ route: "general", reason: "" }), "/ads-check 今天怎么样");
  assert.deepEqual(slash.seen, []);
  assert.match(slash.captured.skillInstruction, /广告自动化排查/);
});

test("OOS route explains unsupported action and disables hosted search", async () => {
  const tools = { definitions: [{ type: "function", function: { name: "read_file" } }] };
  const { captured, run } = await runWith(async () => ({ route: "out-of-scope", reason: "未提供广告写入工具" }), "创建广告组", tools);
  assert.deepEqual(captured.toolDefinitions, []);
  assert.match(captured.skillInstruction, /超出当前业务工具范围/);
  assert.equal(captured.hostedSearch, false);
  assert.equal(JSON.parse(run.skillSnapshot), null);
});

test("router receives bounded completed conversation for follow-up questions", async () => {
  const store = new SessionStore(":memory:");
  const runtime = { info: { kind: "responses", model: "fixture", label: "fixture" }, async *stream() { yield "ok"; } };
  const coordinator = new RunCoordinator(store, runtime, () => {}, 1000);
  let received;
  coordinator.setRouter(async (_text, history) => { received = history; return { route: "general", reason: "fixture" }; });
  try {
    const session = store.create();
    const first = store.accept(session.id, "first", "查昨天的 Airflow");
    store.start(first.id); store.appendOutput(first.id, "昨天的任务已查完"); store.finish(first.id, "completed");
    coordinator.accept(session.id, "follow", "那今天呢");
    const end = Date.now() + 2000;
    while (!received && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(received, [{ role: "user", content: "查昨天的 Airflow" }, { role: "assistant", content: "昨天的任务已查完" }]);
  } finally { await coordinator.shutdown(); store.close(); }
});
