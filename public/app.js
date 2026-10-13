import { mergeRun, visibleRuns } from "/client-state.js";
import { taskView } from "/task-view-model.js";
import { setupAutomationDashboard } from "/automation-dashboard.js";
import { renderGrowthTopic, renderDIResult } from "/growth-view.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  socket: null, ready: false, pending: new Map(), sessions: new Map(), runs: new Map(),
  selected: sessionStorage.getItem("mirror.session") ?? localStorage.getItem("mirror.session"), selection: 0, sending: false,
  cards: new Map(), displayKey: null, retry: null, runtime: null, capabilities: [],
  inspectedRunId: null, taskDetails: new Map(),
  verification: null, limits: null, verificationCaseId: null, page: "chat", evaluation: null, evaluationCase: null, evaluationCaseId: null,
};
const statusLabels = { queued: "排队中", running: "正在回答", completed: "已完成", cancelled: "已停止", failed: "执行失败", interrupted: "已中断" };
const phaseLabels = { waiting_children: "等待子 Agent", queued: "等待执行", model_running: "模型处理中", awaiting_approval: "等待工具审批",
  tool_approved: "工具已批准", tool_running: "工具执行中", model_resume: "工具结束，模型继续",
  completed: "步骤完成", failed: "步骤失败", cancelled: "步骤已停止", interrupted: "步骤已中断" };
const eventLabels = { "child.created": "子任务已派发", "children.returned": "子任务结果已回传", "run.accepted": "任务已接收", "run.started": "开始执行", "run.requeued": "重启后重新排队",
  "run.suspended": "服务关闭，等待恢复", "run.interrupted": "运行中断", "run.completed": "任务完成",
  "run.failed": "任务失败", "run.cancelled": "任务已停止", "web.search": "方舟执行联网搜索", "web.sources": "取得网页引用", "tool.requested": "请求工具审批",
  "tool.approved": "工具已批准", "tool.rejected": "工具被拒绝", "tool.approval_resumed": "恢复待审批工具",
  "tool.started": "工具开始执行", "tool.completed": "工具结果已保存", "tool.failed": "工具执行失败",
  "tool.blocked": "安全策略已阻止", "tool.effect_unknown": "执行结果待核对",
  "model.context_ready": "模型上下文已准备", "model.repair_recorded": "引用修正已记录",
  "run.steer_requested": "收到引导", "run.steer_restarted": "按引导重新生成" };
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}
function notice(message = "") { $("#notice").textContent = message; $("#notice").hidden = !message; }
function fail(error) { notice(error instanceof Error ? error.message : String(error)); }
function request(method, params = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("连接已断开，正在重连。"));
  const socket = state.socket;
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("请求确认超时，可用相同内容重试。")); }, 15_000);
    state.pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: "req", id, method, params })); }
    catch (error) { clearTimeout(timer); state.pending.delete(id); reject(error); }
  });
}
function mergeSession(session) {
  const previous = state.sessions.get(session.id);
  if (!previous || session.generation > previous.generation ||
      (session.generation === previous.generation && session.updatedAt >= previous.updatedAt)) {
    state.sessions.set(session.id, session);
  }
}
async function refreshSessions() {
  const result = await request("sessions.list", { includeArchived: true });
  for (const session of result.sessions) mergeSession(session);
  scheduleRender();
  return result.sessions;
}
async function selectSession(id) {
  const token = ++state.selection;
  state.selected = id;
  state.page = "chat";
  closeTask();
  sessionStorage.setItem("mirror.session", id);
  scheduleRender();
  const result = await request("chat.history", { sessionId: id });
  mergeSession(result.session);
  for (const run of [...result.runs, ...(result.childRuns ?? [])]) mergeRun(state.runs, run);
  if (token === state.selection) scheduleRender();
}
function closeTask() {
  state.inspectedRunId = null;
  $("#task-panel").hidden = true;
}
function detailSection(title, content) {
  const section = document.createElement("section"); section.className = "task-section";
  const heading = document.createElement("h3"); heading.textContent = title;
  section.append(heading, content); return section;
}
function paragraph(value, className = "") {
  const node = document.createElement("p"); node.className = className; node.textContent = value; return node;
}
function element(tag, className = "", content = "") {
  const node = document.createElement(tag); node.className = className; node.textContent = content; return node;
}
function scoreLabel(run) {
  if (!run) return "未运行";
  if (run.status !== "completed") return `失败 · ${run.reasons.join("、")}`;
  if (run.score.jointEM) return "联合 EM 通过";
  return run.reasons.join("、");
}
function formatToolData(raw) {
  if (typeof raw !== "string") return "无结果";
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
function approvalPreview(call) {
  const block = element("div", "approval-preview");
  const title = call.label ? call.label : call.name === "delegate_task" ? "派发子 Agent · 请检查每个任务的 Agent、内容和编号" : call.name === "run_javascript" ? "运行 JavaScript · 请检查完整代码"
    : call.name === "write_file" ? "写入工作区文件 · 请检查路径和内容"
      : call.name === "fetch_url" ? "读取外部网页" : `工具请求：${call.name}`;
  block.append(element("strong", "", title));
  block.append(paragraph("等待审批暂停执行计时；连续等待上限 10 分钟，单次运行总期限 30 分钟。超时原因会显示在任务中。"));
  const risks = { read: "读取资料", network_read: "访问外部网页", write: "修改工作区文件", execute: "执行代码", delegate: "派发只读子任务（孩子的工具仍需审批）", unknown: "未知能力" };
  block.append(paragraph(`影响：${call.name === "di_export_table" ? "读取 DI 表并导出本机 CSV；会复用或创建 Spark 会话，不修改源表" : call.name === "di_query_sql" ? "执行只读 SQL；CLI 会复用或创建会话，返回预览，不导出 CSV" : call.name === "record_automation_check" ? "写入本机排查记录和 config/check-records.json 指定的 GSheet；不修改 Airflow、SQL 或广告" : risks[call.risk] ?? "请核对工具参数"}`));
  let argument = formatToolData(call.arguments);
  if (call.name === "run_javascript") {
    try { argument = JSON.parse(call.arguments).code; } catch { /* Show original arguments. */ }
  }
  block.append(element("pre", "", argument));
  return block;
}
function renderEvaluationDetail() {
  const target = $("#evaluation-detail");
  const detail = state.evaluationCase;
  if (!state.evaluationCaseId) { target.replaceChildren(); return; }
  if (!detail) { target.replaceChildren(paragraph("正在读取题目详情…", "eval-muted")); return; }
  const head = element("div", "eval-detail-head");
  head.append(element("h2", "", detail.question ?? `题目 ${detail.id}`), paragraph(`题目 ID：${detail.id}`, "eval-muted"));
  const gold = element("div", "eval-gold");
  gold.append(element("strong", "", "评测标准"), paragraph(`答案：${detail.goldAnswer ?? "数据集与报告校验不一致，无法显示"}`),
    paragraph(`支持事实：${detail.goldSupport?.join("；") ?? "不可用"}`, "eval-muted"));
  const comparison = element("div", "eval-comparison");
  for (const mode of ["research", "research2"]) {
    const run = detail.runs.find((item) => item.mode === mode);
    const column = element("article", "eval-mode-detail");
    column.append(element("h3", "", `/${mode}`));
    if (!run) { column.append(paragraph("此入口未运行")); comparison.append(column); continue; }
    const outcome = paragraph(scoreLabel(run), `eval-outcome ${run.score.jointEM && run.status === "completed" ? "pass" : "fail"}`);
    column.append(outcome, paragraph(`状态：${run.status} · 耗时 ${(run.durationMs / 1000).toFixed(1)} 秒`, "eval-muted"),
      paragraph(`提取答案：${run.answerExtracted || "未提取"}`),
      paragraph(`答案 EM：${run.score.answerEM ? "通过" : "未通过"} · 支持事实 EM：${run.score.supportEM ? "通过" : "未通过"} · 联合 EM：${run.score.jointEM ? "通过" : "未通过"}`),
      paragraph(`回答引用：${run.citations.length ? run.citations.join("；") : "无"}`, "eval-muted"));
    if (run.error) column.append(paragraph(`错误：${run.error}`, "eval-error"));
    column.append(element("h4", "", "模型输出"), paragraph(run.output || "没有输出", "eval-output"));
    if (run.repair?.attempted) {
      const repair = element("details", "eval-trace");
      repair.append(element("summary", "", `引用修正 · ${run.repair.succeeded ? "成功" : "未成功"}`),
        paragraph(String(run.repair.initialError ?? ""), "eval-error"),
        paragraph(String(run.repair.repairOutput ?? ""), "eval-output"));
      column.append(repair);
    }
    const trace = element("div", "eval-calls"); trace.append(element("h4", "", `工具轨迹 · ${run.calls.length} 次`));
    for (const [index, call] of run.calls.entries()) {
      const item = element("details", "eval-trace");
      item.append(element("summary", "", `${index + 1}. ${call.name} · ${call.status}`),
        element("pre", "", `参数：\n${formatToolData(call.arguments)}\n\n结果：\n${formatToolData(call.result)}`));
      trace.append(item);
    }
    column.append(trace); comparison.append(column);
  }
  target.replaceChildren(head, gold, comparison);
}
function renderEvaluation() {
  const target = $("#evaluation-content");
  const report = state.evaluation;
  if (!report) { target.replaceChildren(paragraph("正在读取评测报告…")); return; }
  if (!report.available) { target.replaceChildren(element("h2", "", "尚无评测报告"), paragraph(report.message)); return; }
  const intro = element("div", "eval-intro");
  intro.append(element("h2", "", "HotpotQA · 固定 10 题对照"),
    paragraph(`模型：${report.model} · ${report.cases.length} 题 · 报告完成于 ${report.finishedAt ?? "进行中"}`, "eval-muted"),
    paragraph("分数来自已保存的 Gateway 配对评测。每题两种入口分别运行；失败的运行不计为答对。", "eval-muted"));
  if (!report.datasetMatched) intro.append(paragraph("当前 HotpotQA 数据集与评测报告的 SHA-256 不一致，原题和标准答案暂不显示。", "eval-error"));
  const stats = element("div", "eval-stats");
  for (const mode of ["research", "research2"]) {
    const item = report.summary[mode];
    if (!item) continue;
    const card = element("div", "eval-stat");
    card.append(element("strong", "", `/${mode}`), element("b", "", `${item.jointEM}/${item.attempted}`),
      paragraph(`联合 EM · 完成 ${item.completed}/${item.attempted} · 工具错误 ${item.toolErrors}`)); stats.append(card);
  }
  const rows = element("div", "eval-rows");
  rows.append(element("h3", "", "逐题对照 · 点击题目看答案和工具轨迹"));
  for (const [index, item] of report.cases.entries()) {
    const button = element("button", `eval-row ${item.id === state.evaluationCaseId ? "active" : ""}`);
    const question = element("span", "eval-row-question", `${index + 1}. ${item.question ?? item.id}`);
    button.append(question);
    for (const mode of ["research", "research2"]) {
      const run = item.runs.find((entry) => entry.mode === mode);
      button.append(element("span", `eval-row-result ${run?.score.jointEM && run.status === "completed" ? "pass" : "fail"}`,
        `${mode}: ${scoreLabel(run)}`));
    }
    button.onclick = () => { void openEvaluationCase(item.id); };
    rows.append(button);
  }
  target.replaceChildren(intro, stats, rows, paragraph("历史评测使用临时 SQLite，已保存工具轨迹，但不能跳回原 Run。", "eval-muted"));
}
async function openEvaluationCase(id) {
  state.evaluationCaseId = id; state.evaluationCase = null;
  renderEvaluation(); renderEvaluationDetail();
  try {
    const detail = await request("evaluation.detail", { id });
    if (state.evaluationCaseId !== id) return;
    state.evaluationCase = detail; renderEvaluationDetail();
    $("#evaluation-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { fail(error); }
}
async function showEvaluation() {
  state.page = "evaluation"; closeTask(); renderEvaluation(); scheduleRender();
  try { state.evaluation = await request("evaluation.overview"); renderEvaluation(); renderEvaluationDetail(); }
  catch (error) { fail(error); }
}
const verificationLabels = { passed: "通过", failed: "失败", blocked: "环境阻塞", skipped: "跳过", incomplete: "轮次不完整" };
async function showVerification() {
  state.page = "verification"; closeTask(); scheduleRender();
  const target = $("#verification-content");
  target.replaceChildren(paragraph("正在读取验收报告…"));
  try {
    const [report, limits] = await Promise.all([request("verification.overview"), request("system.limits")]);
    if (state.page !== "verification") return;
    state.verification = report; state.limits = limits;
    const intro = element("div", "eval-intro");
    intro.append(element("h2", "", "可重复工程验收"), paragraph("受控接口与故障注入结果；真实模型问答质量请查看 HotpotQA 评测。", "eval-muted"));
    const refresh = element("button", "", "刷新报告与限流状态"); refresh.onclick = () => void showVerification(); intro.append(refresh);
    const metrics = element("details", "eval-trace"); metrics.append(element("summary", "", "当前限流配置与计数（进程重启后清零）"), element("pre", "", JSON.stringify(limits, null, 2)));
    target.replaceChildren(intro, metrics);
    $("#verification-detail").replaceChildren(); state.verificationCaseId = null;
    if (!report.available) { target.append(paragraph(report.message)); return; }
    target.append(paragraph(`${report.summary.passed}/${report.summary.total} 场景全部轮次通过 · 每项 ${report.repeats} 轮 · 失败 ${report.summary.failed} · 阻塞 ${report.summary.blocked} · 跳过或缺失 ${report.summary.skipped}`),
      paragraph(report.freshness === "current" ? "报告与当前磁盘源码一致（不含本机配置、模型与运行中进程版本）。" : report.freshness === "stale" ? "报告已过期：代码已变化，请重新运行 pnpm verify。以下为历史结果。" : "无法核对当前源码，以下为历史结果。", report.freshness === "current" ? "eval-muted" : "eval-error"),
      paragraph(`完成：${report.finishedAt} · Node ${report.environment.node} · 源码 SHA256 ${report.sourceSha256}`, "eval-muted"));
    for (const item of [...report.cases].sort((a, b) => (b.evidenceCount > 0) - (a.evidenceCount > 0))) {
      const row = element("button", "eval-row");
      row.append(element("span", "eval-row-question", `[${item.category}] ${item.name}`),
        element("span", `eval-row-result ${item.status === "passed" ? "pass" : "fail"}`, verificationLabels[item.status]),
        element("span", "eval-muted", item.evidenceCount ? `${item.evidenceCount} 轮含完整证据` : "仅断言记录"));
      row.onclick = async () => {
        state.verificationCaseId = item.id;
        try {
          const detail = await request("verification.detail", { id: item.id });
          if (state.verificationCaseId !== item.id || state.page !== "verification") return;
          const panel = $("#verification-detail"); panel.replaceChildren(element("h2", "eval-detail-head", detail.name), paragraph(detail.file, "eval-muted"));
          for (const run of detail.observations) {
            const block = element("section", "eval-mode-detail");
            block.append(element("h3", "", `第 ${run.iteration} 轮 · ${verificationLabels[run.status]} · ${run.durationMs.toFixed(1)} ms`));
            if (run.failureCode || run.failureReason) block.append(paragraph(`${run.failureCode ?? ""} ${run.failureReason ?? ""}`, "eval-error"));
            if (run.evidence) for (const [key, label] of Object.entries({ input: "输入", config: "配置", expected: "预期", actual: "实际结果", trace: "Trace" })) {
              const evidence = element("details", "eval-trace"); evidence.append(element("summary", "", label), element("pre", "", JSON.stringify(run.evidence[key], null, 2))); block.append(evidence);
            }
            else block.append(paragraph("此项只有测试断言、状态和耗时，没有保存业务 Trace。", "eval-muted"));
            panel.append(block);
          }
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) { fail(error); }
      };
      target.append(row);
    }
  } catch (error) { target.replaceChildren(paragraph(error.message, "eval-error")); }
}
async function loadTaskDetails(runId, seq) {
  const previous = state.taskDetails.get(runId);
  if (previous?.loading) return;
  state.taskDetails.set(runId, { ...previous, loading: true });
  renderTaskPanel();
  try {
    const [{ events }, { attempts }] = await Promise.all([
      request("runs.events", { runId }), request("runs.attempts", { runId }),
    ]);
    state.taskDetails.set(runId, { events, attempts, seq, loading: false });
  } catch (error) {
    state.taskDetails.set(runId, { ...previous, loading: false, error: error.message });
  }
  if (state.inspectedRunId === runId) renderTaskPanel();
}
function inspectRun(runId) {
  state.inspectedRunId = runId;
  $("#task-panel").hidden = false;
  renderTaskPanel();
  const run = state.runs.get(runId);
  const seq = JSON.parse(run?.checkpoint || "{}").seq ?? 0;
  void loadTaskDetails(runId, seq);
}
function renderTaskPanel() {
  const run = state.runs.get(state.inspectedRunId);
  const selected = state.sessions.get(state.selected);
  if (!run || (run.parentRunId ? state.runs.get(run.parentRunId)?.sessionId !== selected?.id || state.runs.get(run.parentRunId)?.generation !== selected?.generation : run.sessionId !== selected?.id || run.generation !== selected.generation)) { closeTask(); return; }
  const details = state.taskDetails.get(run.id);
  const view = taskView(run, details?.events ?? [], details?.attempts ?? []);
  const content = $("#task-content");
  const intro = document.createElement("div"); intro.className = "task-intro";
  intro.append(paragraph(run.input, "task-question"), paragraph(`${statusLabels[run.status]} · ${phaseLabels[view.checkpoint.phase] ?? "暂无步骤"} · 第 ${view.checkpoint.seq ?? 0} 步`, "task-state"));
  const refresh = document.createElement("button"); refresh.textContent = details?.loading ? "读取中…" : "刷新记录";
  refresh.disabled = !state.ready || Boolean(details?.loading);
  refresh.onclick = () => { void loadTaskDetails(run.id, view.checkpoint.seq ?? 0); };
  intro.append(refresh);
  const download = element("a", "", "下载执行 Trace JSON");
  download.href = `/api/runs/${encodeURIComponent(run.id)}/trace.json`;
  download.download = `run-${run.id}.json`;
  intro.append(download);
  if (run.error) intro.append(paragraph(run.error, "run-error"));
  const toolDetails = element("div", "");
  const pretty = value => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } };
  for (const call of view.calls) {
    const item = element("details", "eval-trace");
    item.open = ["running", "failed", "unknown", "interrupted"].includes(call.status);
    item.append(element("summary", "", `${call.name} · ${call.status}`),
      paragraph(`调用 ID：${call.id}`), paragraph(`开始：${call.startedAt} · 结束：${call.endedAt ?? "尚未结束"}`, "task-time"),
      element("h4", "", "执行参数"), element("pre", "", pretty(call.arguments)),
      element("h4", "", "返回结果 / 错误"), element("pre", "", call.result === null ? "尚未收到工具结果" : pretty(call.result)));
    toolDetails.append(item);
  }
  if (!view.calls.length) toolDetails.append(paragraph("尚未调用工具。"));
  const recovery = document.createElement("div");
  recovery.append(paragraph(`重启恢复 ${view.attempts.length} 次`, "task-count"));
  for (const attempt of view.attempts) {
    const item = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = `第 ${attempt.attempt} 次中断 · ${attempt.interruptedAt}`;
    item.append(summary, paragraph(attempt.partialOutput || "中断前无模型输出", "task-draft")); recovery.append(item);
  }
  const timeline = document.createElement("ol"); timeline.className = "task-timeline";
  for (const event of view.events) {
    const item = document.createElement("li");
    const label = eventLabels[event.type] ?? event.type;
    const tool = event.detail?.name ? ` · ${event.detail.name}` : "";
    item.append(paragraph(`${label}${tool}`), paragraph(event.createdAt, "task-time")); timeline.append(item);
  }
  if (!view.events.length) timeline.append(paragraph(details?.loading ? "正在读取步骤…" : "暂无步骤事件"));
  const evidence = document.createElement("div");
  evidence.append(paragraph("出处来自本次工具实际打开的 HotpotQA 文章；句子编号可与回答中的 [标题#编号] 对照。", "task-explain"));
  for (const source of view.sources) {
    const article = document.createElement("details"); article.className = "task-source";
    const summary = document.createElement("summary"); summary.textContent = `${source.title}${source.hop ? ` · 第 ${source.hop} 跳` : ""} · ${source.sentences.length} 句 · 回答引用 ${source.cited} 句`;
    article.append(summary);
    for (const sentence of source.sentences) article.append(paragraph(`${sentence.citation}  ${sentence.text}`, "task-sentence"));
    evidence.append(article);
  }
  if (!view.sources.length) evidence.append(paragraph("这条任务尚未保存已打开的文章。"));
  const approval = document.createElement("div"); approval.className = "task-approval";
  for (const call of view.pendingApprovals) {
    const item = document.createElement("div"); item.className = "task-approval-item";
    item.append(approvalPreview(call));
    for (const [decision, label] of [["approved", "允许这次"], ["rejected", "拒绝"]]) {
      const button = document.createElement("button"); button.textContent = label; button.disabled = !state.ready;
      button.onclick = () => {
        for (const sibling of item.querySelectorAll("button")) sibling.disabled = true;
        void request("tools.decide", { runId: run.id, toolCallId: call.id, decision })
          .catch((error) => { fail(error); renderTaskPanel(); });
      };
      item.append(button);
    }
    approval.append(item);
  }
  content.replaceChildren(intro, ...(view.pendingApprovals.length ? [approval] : []), detailSection("恢复记录", recovery),
    detailSection("工具参数与结果", toolDetails), detailSection("步骤时间线", timeline), detailSection("资料出处", evidence));
  if (details?.error) content.prepend(paragraph(`读取记录失败：${details.error}`, "task-approval"));
}
function render() {
  const selected = state.sessions.get(state.selected);
  const evaluationOpen = state.page === "evaluation";
  const verificationOpen = state.page === "verification";
  const automationOpen = state.page === "automation";
  const reportOpen = evaluationOpen || verificationOpen || automationOpen;
  $("#growth-topic").hidden = reportOpen || selected?.topicId !== "growth";
  $("#growth-start").disabled = !state.ready;
  $("#automation-view").hidden = !automationOpen;
  $("#automation-toggle").textContent = automationOpen ? "返回会话" : "自动化看板";
  $("#verification-toggle").disabled = !state.ready;
  $("#verification-toggle").textContent = verificationOpen ? "返回会话" : "验收报告";
  $("#verification-view").hidden = !verificationOpen;
  $("#evaluation-toggle").disabled = !state.ready;
  $("#evaluation-view").hidden = !evaluationOpen;
  $("#messages").hidden = reportOpen;
  $("#composer-wrap").hidden = reportOpen;
  $("#reset-session").hidden = reportOpen;
  $("#evaluation-toggle").textContent = evaluationOpen ? "返回会话" : "评测";
  $("#page-path").textContent = automationOpen ? "工作区 / 自动化" : verificationOpen ? "工作区 / 验收报告" : evaluationOpen ? "工作区 / 评测" : "工作区 / 会话";
  if (state.runtime) {
    $("#mode-banner").textContent = automationOpen ? "只读自动化看板 · 调度、规则和广告操作结果分别核对。" : verificationOpen ? "工程验收报告 · 读取已保存的结果和当前限流计数，不会调用模型。" : evaluationOpen
      ? "历史评测报告 · 页面只读取已保存的结果，不会调用当前模型。"
      : state.runtime.kind === "demo"
        ? "演示模式 · 当前只返回回声，不会调用模型。点击左侧「模型配置」接入已有接口。"
        : `已连接模型：${state.runtime.model}${selected?.topicId === "growth" ? " · 商品成长主题 · 只读 DI 数据分析" : state.runtime.kind === "responses" && state.runtime.webSearch ? " · 联网搜索已启用（方舟服务端自动执行）" : ""}`;
  }
  const writable = state.ready && selected && !selected.archived;
  $("#input").disabled = !writable;
  $("#send").disabled = !writable || state.sending;
  $("#new-session").disabled = !state.ready;
  const runs = visibleRuns(state.runs, selected);
  const pending = runs.filter((run) => ["queued", "running"].includes(run.status));
  const activeRun = pending.find((run) => run.status === "running");
  $("#send").textContent = activeRun ? "引导当前运行 ↑" : "发送 ↑";
  $("#reset-session").disabled = !writable || pending.length > 0;
  $("#title").textContent = automationOpen ? "SCS 广告执行看板" : verificationOpen ? "稳定性验收" : evaluationOpen ? "HotpotQA 评测" : selected?.title ?? "正在连接";
  $("#composer-hint").textContent = !state.ready ? "正在重连" : selected?.archived ? "归档会话只读"
    : activeRun ? "当前回答生成中；发送内容会作为引导重新组织这次回答" : pending.length ? `${pending.length} 个任务待完成，可继续发送` : "Enter 发送 · /stop 停止 · /new 新会话";
  const visibleSessions = [...state.sessions.values()].filter((session) => !session.archived || $("#show-archived").checked);
  const visibleById = new Map(visibleSessions.map((session) => [session.id, session]));
  const children = new Map();
  for (const session of visibleSessions) {
    const parentId = session.parentId && visibleById.has(session.parentId) ? session.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(session);
    children.set(parentId, siblings);
  }
  const ordered = []; const visited = new Set();
  function addBranch(parentId, depth) {
    const siblings = children.get(parentId) ?? [];
    siblings.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const session of siblings) {
      if (visited.has(session.id)) continue;
      visited.add(session.id); ordered.push({ session, depth }); addBranch(session.id, depth + 1);
    }
  }
  addBranch(null, 0);
  const buttons = ordered.map(({ session, depth }) => {
    const button = document.createElement("button");
    button.className = `session ${session.id === state.selected ? "active" : ""} ${session.archived ? "archived" : ""}`;
    button.textContent = (session.archived ? "▧ " : depth ? "↳ " : "◦ ") + session.title;
    button.title = session.title;
    button.style.paddingLeft = `${12 + Math.min(depth, 4) * 16}px`;
    button.onclick = () => { void selectSession(session.id).catch(fail); };
    return button;
  });
  $("#sessions").replaceChildren(...buttons);

  const key = selected ? `${selected.id}:${selected.generation}` : null;
  if (state.displayKey !== key) {
    state.displayKey = key; state.cards.clear(); $("#messages").replaceChildren();
  }
  const pane = $("#messages");
  if (selected?.generation > 0 && !pane.querySelector(".reset-marker")) {
    const marker = document.createElement("div"); marker.className = "reset-marker";
    marker.textContent = "会话已重置 · 之前的对话已清除";
    pane.prepend(marker);
  }
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
  if (!runs.length && !pane.querySelector(".welcome")) {
    const empty = document.createElement("div"); empty.className = "welcome";
    const icon = document.createElement("span"); icon.className = "welcome-icon"; icon.textContent = "M";
    const title = document.createElement("h2"); title.textContent = "从一项任务开始";
    const text = document.createElement("p"); text.textContent = "可以研究资料、操作工作区文件和读取网页。工具调用会先等待你审批；代码执行默认关闭。";
    if (selected?.topicId === "growth") text.textContent = "直接描述站点、时间和你想比较的成长指标。实际查询先等待审批，完成后展示数据表、SQL 和 CSV。";
    const starters = element("div", "starter-actions");
    for (const [label, prompt] of [
      ["协作研究", "/team 请派发两个 reader 子 Agent：第一个读取 agent_demo.txt 并概括，第二个列出工作区文件。等待二者完成后汇总，并引用每个子任务。"],
      ["查看文件", "请调用 list_workspace 列出工作区根目录，告诉我有哪些文件。"],
      ["新建文件", "请在工作区创建 tonight-note.txt，内容为：今晚完成多类型 Agent 能力。请调用 write_file。"],
      ["读取网页", "请调用 fetch_url 读取这个网页并概括，网址是：https://www.wikipedia.org/"],
      ["运行代码", "请调用 run_javascript 执行 console.log(2 + 3)，告诉我实际输出。"],
    ]) {
      const button = element("button", "", label);
      if (label === "运行代码" && !state.capabilities.some((tool) => tool.name === "run_javascript" && tool.enabled)) {
        button.disabled = true; button.textContent = "代码执行未启用";
      }
      button.onclick = () => { $("#input").value = prompt; $("#input").focus(); };
      starters.append(button);
    }
    empty.append(icon, title, text); if (selected?.topicId !== "growth") empty.append(starters); pane.append(empty);
  }
  if (runs.length) pane.querySelector(".welcome")?.remove();
  for (const run of runs) {
    let card = state.cards.get(run.id);
    if (!card) {
      const container = document.createElement("article"); container.className = "turn";
      const user = document.createElement("div"); user.className = "user";
      const input = document.createElement("div"); input.className = "user-content"; input.textContent = run.input; user.append(input);
      const output = document.createElement("div"); output.className = "assistant";
      const meta = document.createElement("div"); meta.className = "run-meta";
      const status = document.createElement("span"); status.className = "run-status";
      const step = document.createElement("span"); step.className = "run-step";
      const stop = document.createElement("button"); stop.textContent = "停止";
      stop.onclick = () => { void request("chat.abort", { runId: run.id }).then(({ run }) => { mergeRun(state.runs, run); scheduleRender(); }).catch(fail); };
      const inspect = document.createElement("button"); inspect.textContent = "任务详情";
      inspect.onclick = () => inspectRun(run.id);
      meta.append(status, step, inspect, stop);
      const error = document.createElement("div"); error.className = "run-error";
      const toolActions = document.createElement("div"); toolActions.className = "tool-actions";
      const details = document.createElement("details"); details.className = "run-details";
      const summary = document.createElement("summary"); summary.textContent = "运行记录";
      const detailText = document.createElement("code");
      const eventText = document.createElement("code");
      const refreshEvents = document.createElement("button"); refreshEvents.textContent = "刷新步骤事件";
      const loadEvents = () => {
        eventText.textContent = "正在读取步骤事件…";
        void request("runs.events", { runId: run.id }).then(({ events }) => {
          eventText.textContent = events.length ? "步骤事件：\n" + events.map((event) => {
            const payload = JSON.parse(event.payload);
            return `${event.seq}. ${event.type}${payload.id ? ` · ${payload.id}` : ""}`;
          }).join("\n") : "暂无步骤事件";
        }).catch((cause) => { eventText.textContent = `步骤事件读取失败：${cause.message}`; });
      };
      details.addEventListener("toggle", () => { if (details.open) loadEvents(); });
      refreshEvents.onclick = loadEvents;
      details.append(summary, detailText, refreshEvents, eventText);
      const children = element("div", "child-runs");
      const webEvidence = element("div", "web-evidence");
      container.append(user, output, webEvidence, meta, error, toolActions, details, children);
      card = { container, output, status, step, stop, error, toolActions, detailText, children, webEvidence };
      state.cards.set(run.id, card);
    }
    card.webEvidence.replaceChildren();
    for (const entry of JSON.parse(run.providerTrace ?? "[]")) {
      if (entry.event === "agent.action") card.webEvidence.append(paragraph(`行动说明（模型生成，需核对）：${entry.payload.text}`));
      if (entry.event === "web.search") card.webEvidence.append(paragraph(`联网搜索（${entry.payload.status}）：${(entry.payload.queries ?? []).join("；") || "服务商未返回查询词"}`));
      if (entry.event === "web.sources") for (const source of entry.payload.sources ?? []) {
        try {
          const url = new URL(source.url);
          if (!["https:", "http:"].includes(url.protocol)) continue;
          const link = element("a", "", source.title || source.url); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
          card.webEvidence.append(link, document.createElement("br"));
        } catch { /* Invalid source link. */ }
      }
    }
    card.output.textContent = run.output || (run.status === "running" ? "等待模型输出…" : "");
    card.status.textContent = statusLabels[run.status]; card.status.dataset.status = run.status;
    const checkpoint = JSON.parse(run.checkpoint || "{}");
    card.step.textContent = phaseLabels[checkpoint.phase] ?? "";
    card.stop.hidden = !["queued", "running"].includes(run.status); card.stop.disabled = !state.ready;
    card.error.textContent = run.error ?? "";
    const calls = JSON.parse(run.toolTrace || "[]");
    for (const call of calls.filter(c => c.result && ["airflow_scan_failures", "dataservice_api_detail", "record_automation_check"].includes(c.name))) {
      try {
        const result = JSON.parse(call.result);
        if (call.name === "airflow_scan_failures") {
          card.webEvidence.append(paragraph(`扫描范围：${result.start_date} 至 ${result.end_date}（${result.time_zone}）· ${result.owner} 名下 ${result.owned_dags?.length ?? 0} 个 DAG · ${result.failed_tasks?.length ?? 0} 个失败任务`));
        } else if (call.name === "dataservice_api_detail") {
          card.webEvidence.append(paragraph(`SQL 来源：${result.api_name} · 版本 ${result.version} · 副本 ${result.copy} · 状态 ${result.metadata?.status ?? "未知"} · trace ${result.trace_id ?? "未提供"}；历史定义未核对${result.sql_truncated ? "，SQL 已截断" : ""}`));
        } else if (result.record_saved) {
          card.webEvidence.append(paragraph(`排查记录 ${result.record_id}：本地已保存 · ${result.sync_status === "synced" ? "GSheet 已同步" : "GSheet 待同步"}${result.sync_error ? ` · ${result.sync_error}` : ""}`));
        }
      } catch { /* 工具错误文本仍显示在运行记录中。 */ }
    }
    for (const call of calls.filter(c => ["di_export_table", "di_query_sql"].includes(c.name) && c.result)) {
      try {
        const artifact = JSON.parse(call.result);
        if (artifact.state === "completed" && artifact.result_kind === "sql") {
          card.webEvidence.append(renderDIResult(artifact));
          continue;
        }
        if (artifact.state !== "completed" || !/^\/api\/di-exports\/[0-9a-f-]{36}\.csv$/.test(artifact.download_url)) continue;
        const link = element("a", "", `下载 CSV · ${artifact.row_count} 行 · ${artifact.table}`);
        link.href = artifact.download_url; link.download = "";
        card.webEvidence.append(link, paragraph(artifact.bounded_export ? `历史样例：上限 ${artifact.limit} 行。` : `筛选总数 ${artifact.expected_rows} 行 · 已导出 ${artifact.row_count} 行 · 完整性已核对`));
        card.webEvidence.append(renderDIResult(artifact));
      } catch { /* No completed export artifact. */ }
    }
    const uncertain = calls.filter((call) => call.status === "unknown");
    if (uncertain.length) card.error.textContent = [run.error, "有工具执行结果待核对，可能已经修改文件；请检查实际结果后再决定是否重试。"].filter(Boolean).join("\n");
    card.toolActions.replaceChildren(...calls.filter((call) => call.status === "requested").map((call) => {
      const box = document.createElement("div"); box.className = "tool-approval";
      const text = approvalPreview(call);
      const allow = document.createElement("button"); allow.textContent = "允许这次";
      allow.onclick = () => { void request("tools.decide", { runId: run.id, toolCallId: call.id, decision: "approved" }).catch(fail); };
      const deny = document.createElement("button"); deny.textContent = "拒绝";
      deny.onclick = () => { void request("tools.decide", { runId: run.id, toolCallId: call.id, decision: "rejected" }).catch(fail); };
      box.append(text, allow, deny); return box;
    }));
    const callDetails = calls.map((call, index) =>
      `工具 ${index + 1}：${call.name} · ${call.status}\n参数：${call.arguments}\n结果：${call.result === null ? "等待中" : call.result.slice(0, 8000)}`);
    const context = JSON.parse(run.contextTrace || "{}");
    const contextDetails = Number.isInteger(context.budgetChars)
      ? `\n\n上下文：${context.usedChars}/${context.budgetChars} 字符 · ${context.messageCount} 条消息${context.skillId ? `\nSkill：${context.skillId} ${context.skillVersion}${context.skillSource ? ` · ${context.skillSource}` : ""}` : ""}${context.totalBudgetChars ? `\n总预算：${context.totalBudgetChars} · 系统提示和工具定义：${context.systemAndToolDefinitionChars} · 输出预留：${context.outputReserveChars} · 工具结果预留：${context.toolResultReserveChars}（已执行结果：${calls.filter((call) => call.status === "completed" || call.status === "failed").reduce((sum, call) => sum + (call.result?.length ?? 0), 0)}）` : ""}\n保留历史轮次：${context.includedTurns} · 裁掉最旧轮次：${context.omittedTurns}${context.memorySnapshotId ? `\n历史记忆：${context.memoryStatus} · 版本 ${context.memoryVersion ?? 0} · ${context.memoryChars} 字符 · 快照 ${context.memorySnapshotId}` : ""}${context.steerChars ? ` · 引导：${context.steerChars} 字符` : ""}` : "";
    card.detailText.textContent = `运行：${run.id}\n状态：${run.status}\n接收：${run.acceptedAt}\n开始：${run.startedAt ?? "—"}\n结束：${run.endedAt ?? "—"}` +
      (checkpoint.seq ? `\n步骤检查点：${checkpoint.seq} · ${phaseLabels[checkpoint.phase] ?? checkpoint.phase}${checkpoint.toolCallId ? ` · 工具 ${checkpoint.toolCallId}` : ""}\n已完成工具：${checkpoint.completedToolCallIds?.length ?? 0}` : "") +
      (run.steerTrace && JSON.parse(run.steerTrace).length ? `\n\n引导：${JSON.parse(run.steerTrace).map((entry, index) => `${index + 1}. ${entry.content} · ${entry.appliedAt ? "已送入模型" : "等待重启"}`).join("\n")}` : "") +
      contextDetails + (context.recoveryAttempt ? `\n恢复次数：${context.recoveryAttempt} · 恢复证据：${context.recoveryEvidenceChars} 字符` : "") +
      (callDetails.length ? `\n\n${callDetails.join("\n\n")}` : "");
    renderChildren(card.children, run.id);
    pane.append(card.container);
  }
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
  if (state.inspectedRunId) {
    renderTaskPanel();
    const inspected = state.runs.get(state.inspectedRunId);
    const seq = JSON.parse(inspected?.checkpoint || "{}").seq ?? 0;
    const cached = state.taskDetails.get(state.inspectedRunId);
    if (state.ready && cached && !cached.loading && !cached.error && cached.seq !== seq) {
      void loadTaskDetails(state.inspectedRunId, seq);
    }
  }
}
function renderChildren(target, parentRunId) {
  const children = [...state.runs.values()].filter((run) => run.parentRunId === parentRunId);
  target.replaceChildren();
  if (!children.length) return;
  target.append(element("h3", "", `子 Agent · ${children.filter((run) => run.status === "completed").length}/${children.length} 完成`));
  for (const child of children) {
    const box = element("section", "child-card");
    const insufficient = child.status === "completed" && JSON.parse(child.agentConfig || "{}").research && /^证据不足/u.test(child.output.trim());
    const checkpoint = JSON.parse(child.checkpoint || "{}");
    box.append(element("strong", "", `${child.agentId} · ${child.delegationKey} · ${insufficient ? "已结束 · 证据不足" : statusLabels[child.status]}`),
      paragraph(child.input, "task-question"), paragraph(phaseLabels[checkpoint.phase] ?? "", "eval-muted"));
    const inspect = element("button", "", "子任务详情与出处"); inspect.onclick = () => inspectRun(child.id); box.append(inspect);
    if (["queued", "running"].includes(child.status)) {
      const stop = element("button", "", "停止这个孩子"); stop.disabled = !state.ready;
      stop.onclick = () => void request("chat.abort", { runId: child.id }).catch(fail); box.append(stop);
    }
    const output = element("div", "child-output", child.output); box.append(output);
    if (child.error) box.append(paragraph(child.error, "eval-error"));
    for (const call of JSON.parse(child.toolTrace || "[]").filter((item) => item.status === "requested")) {
      const approval = element("div", "tool-approval"); approval.append(approvalPreview(call));
      for (const [decision, label] of [["approved", "允许这次"], ["rejected", "拒绝"]]) {
        const button = element("button", "", label); button.disabled = !state.ready;
        button.onclick = () => void request("tools.decide", { runId: child.id, toolCallId: call.id, decision }).catch(fail);
        approval.append(button);
      }
      box.append(approval);
    }
    target.append(box);
  }
}
function onEvent(frame) {
  if (frame.event === "run.updated") {
    mergeRun(state.runs, frame.payload.run);
    if (frame.payload.run.status === "queued" || !["queued", "running"].includes(frame.payload.run.status)) {
      void refreshSessions().catch(fail);
    }
  } else if (frame.event === "sessions.changed" || frame.event === "session.reset") {
    mergeSession(frame.payload.session);
    void refreshSessions().catch(fail);
  }
  scheduleRender();
}
function connect() {
  const socket = new WebSocket(`ws://${location.host}/gateway`);
  state.socket = socket;
  socket.onopen = async () => {
    try {
      const connected = await request("connect");
      state.ready = true; state.runtime = connected.runtime; state.capabilities = connected.capabilities ?? [];
      $("#connection").textContent = "● 已连接";
      $("#mode-banner").textContent = connected.runtime.kind === "demo"
        ? "演示模式 · 当前只返回回声，不会调用模型。点击左侧「模型配置」接入已有接口。"
        : `已连接模型：${connected.runtime.model}`;
      $("#mode-banner").classList.toggle("live", connected.runtime.kind !== "demo");
      const sessions = await refreshSessions();
      let id = sessions.some((session) => session.id === state.selected) ? state.selected : sessions.find((s) => !s.archived)?.id;
      if (!id) { const { session } = await request("sessions.create"); mergeSession(session); id = session.id; }
      await selectSession(id);
      if (location.hash === "#automation") { state.page = "automation"; scheduleRender(); void automation.load(); }
    } catch (error) { fail(error); socket.close(); }
  };
  socket.onmessage = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === "res") {
      const pending = state.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer); state.pending.delete(frame.id);
      frame.ok ? pending.resolve(frame.payload) : pending.reject(Object.assign(new Error(frame.error.message), frame.error));
    } else if (frame.type === "event") onEvent(frame);
  };
  socket.onclose = () => {
    state.ready = false; $("#connection").textContent = "● 重连中";
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error("连接中断，正在重连；已接收的任务继续执行。"));
    }
    state.pending.clear(); scheduleRender(); setTimeout(connect, 1200);
  };
  socket.onerror = () => { $("#connection").textContent = "● 连接失败"; };
}

async function reset() {
  const { session } = await request("sessions.reset", { sessionId: state.selected });
  mergeSession(session); await selectSession(session.id);
}
$("#show-archived").onchange = scheduleRender;
$("#verification-toggle").onclick = () => {
  if (state.page === "verification") { state.page = "chat"; scheduleRender(); }
  else void showVerification();
};
$("#evaluation-toggle").onclick = () => {
  if (state.page === "evaluation") { state.page = "chat"; scheduleRender(); }
  else void showEvaluation();
};
$("#close-task").onclick = closeTask;
$("#reset-session").onclick = () => { void reset().catch(fail); };
$("#new-session").onclick = () => {
  void request("sessions.create").then(async ({ session }) => { mergeSession(session); await selectSession(session.id); }).catch(fail);
};
$("#agents-help").onclick = async () => {
  $("#agents-dialog").showModal();
  const target = $("#agents-content"); target.replaceChildren(paragraph("读取中…"));
  try {
    const result = await request("agents.list");
    target.replaceChildren(paragraph(`同时运行 ${result.active}/${result.maxConcurrent} 个孩子，排队 ${result.queued} 个；每个父任务最多 ${result.maxChildren} 个孩子。`),
      paragraph("用 /team 启动协调 Agent。各 Agent 共用当前模型接口；孩子只收到明确分派的任务。"));
    for (const agent of result.agents) {
      target.append(element("h3", "", `${agent.label}（${agent.id}）`), paragraph(`并发 ${agent.maxConcurrent} · 时限 ${agent.timeoutMs / 1000} 秒`),
        paragraph(`工具：${agent.tools.join("、")}`), paragraph(agent.instructions));
    }
    target.append(paragraph("修改项目 config/agents.json 后重启生效。已有任务保存自己的配置快照。"));
  } catch (error) { target.replaceChildren(paragraph(error.message, "eval-error")); }
};
async function loadSkills(refresh = false) {
  const content = $("#skills-content");
  content.replaceChildren(paragraph("正在读取…"));
  try {
    const result = await request(refresh ? "skills.refresh" : "skills.list");
    content.replaceChildren(paragraph(`刷新时间：${result.refreshedAt ?? "尚未刷新"}`));
    for (const error of result.errors ?? []) content.append(paragraph(`${error.id}：${error.message}`, "eval-error"));
    if (result.error) content.append(paragraph(result.error, "eval-error"));
    for (const skill of result.skills) content.append(paragraph(
      `${skill.command} · ${skill.id}\n来源：${skill.source}\n版本 SHA-256：${skill.version}\n${skill.chars} 字符`));
    if (!result.skills.length) content.append(paragraph("没有发现 Skill。"));
  } catch (error) { content.replaceChildren(paragraph(error.message, "eval-error")); }
}
$("#skills-help").onclick = () => { $("#skills-dialog").showModal(); void loadSkills(); };
$("#skills-refresh").onclick = () => { void loadSkills(true); };
$("#config-help").onclick = () => $("#config-dialog").showModal();
$("#input").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("#composer").requestSubmit(); }
};
$("#composer").onsubmit = async (event) => {
  event.preventDefault();
  if (state.sending || !state.ready) return;
  const input = $("#input"); const content = input.value.trim(); const sessionId = state.selected;
  if (!content || !sessionId) return;
  notice(); state.sending = true; scheduleRender();
  try {
    if (content === "/new") {
      const { session } = await request("sessions.new", { currentSessionId: sessionId });
      mergeSession(session); await selectSession(session.id);
    } else if (content === "/reset") await reset();
    else if (content === "/stop") {
      const run = visibleRuns(state.runs, state.sessions.get(sessionId)).find((r) => ["running", "queued"].includes(r.status));
      if (run) await request("chat.abort", { runId: run.id });
    } else {
      const generation = state.sessions.get(sessionId)?.generation;
      const activeRun = visibleRuns(state.runs, state.sessions.get(sessionId)).find((run) => run.status === "running");
      const kind = activeRun ? "steer" : "send";
      if (!state.retry || state.retry.sessionId !== sessionId || state.retry.content !== content || state.retry.generation !== generation ||
          state.retry.kind !== kind || state.retry.runId !== activeRun?.id) {
        state.retry = { sessionId, content, generation, kind, runId: activeRun?.id, clientRequestId: crypto.randomUUID() };
      }
      const { run } = kind === "steer"
        ? await request("chat.steer", { runId: activeRun.id, clientRequestId: state.retry.clientRequestId, content })
        : await request("chat.send", state.retry);
      mergeRun(state.runs, run); state.retry = null;
    }
    if (input.value.trim() === content) input.value = "";
  } catch (error) { fail(error); }
  finally { state.sending = false; scheduleRender(); }
};
const automation = setupAutomationDashboard(() => state.page === "automation");
$("#automation-toggle").onclick = () => {
  state.page = state.page === "automation" ? "chat" : "automation";
  closeTask(); scheduleRender();
  if (state.page === "automation") void automation.load();
};
connect();
if (location.hash === "#automation") $("#automation-toggle").click();
window.addEventListener("hashchange", () => { if (location.hash === "#automation" && state.page !== "automation") $("#automation-toggle").click(); });

$("#growth-start").onclick = async () => {
  try {
    const result = await request("sessions.create", { topicId: "growth" });
    mergeSession(result.session); await selectSession(result.session.id);
  } catch (error) { fail(error); }
};
fetch("/api/topics").then(response => { if (!response.ok) throw new Error("主题目录读取失败"); return response.json(); }).then(({ topics }) => {
  const topic = topics.find(t => t.id === "growth");
  if (topic) renderGrowthTopic($("#growth-topic"), topic, question => {
    $("#input").value = question; $("#input").focus();
  });
}).catch(fail);
