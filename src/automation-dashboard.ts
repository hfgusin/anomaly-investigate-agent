import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
const table = "cnfashionbi_scs.ads_scs_mature_take_rate_script_data";
const sheetId = "1G-QMFOPEuqcUQH5YV4lOAuNoifoZ1NKd9Kc3CJLoGlQ";
const airflowBase = () => process.env.AUTOMATION_AIRFLOW_BASE_URL || "http://34.142.225.103:8080";
type Row = Record<string, any>;
type Source = { mode: string; observed_at: string | null; error?: string; data: any };
type Snapshot = { date: string; airflow: Source; rules: Source; business: Source };
type Job = { id: string; date: string; status: string; phase: string; statements: number[];
  notice: unknown[]; error?: string; started_at: string; session: string; identity: string };
const stamp = () => new Date().toISOString();
function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw new Error("日期必须为有效的 YYYY-MM-DD。");
  return date;
}
function records(statement: any): Row[] {
  if (statement?.state !== "available" || statement?.output?.status !== "ok") throw new Error("DI statement 未成功完成。");
  const t = statement.output.data?.["application/json"];
  if (!Array.isArray(t?.schema?.fields) || !Array.isArray(t.data)) throw new Error("DI 结果缺少表格结构。");
  return t.data.map((row: any[]) => Object.fromEntries(t.schema.fields.map((f: any, i: number) => [f.name, row[i]])));
}
export function summarize(groups: Row[]) {
  const regions: Record<string, Row> = {};
  for (const row of groups) {
    const n = Number(row.log_rows);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("日志数量无效。");
    const key = String(row.region ?? "未知站点");
    const target = regions[key] ??= { region: key, log_rows: 0, success: 0, failed: 0, not_executed: 0, unknown: 0, first: null, last: null };
    target.log_rows += n;
    const status = ["success","failed","not_executed"].includes(row.execution_status) ? row.execution_status : "unknown";
    target[status] += n;
    if (row.first_execution_time && (!target.first || row.first_execution_time < target.first)) target.first = row.first_execution_time;
    if (row.last_execution_time && (!target.last || row.last_execution_time > target.last)) target.last = row.last_execution_time;
  }
  return Object.values(regions);
}

/** One read-only pilot. SQL/table/origins cannot be provided by browser or model. */
export class AutomationDashboard {
  private directory: string;
  private job: Job | null = null;
  private controller = new AbortController();
  private active = false;
  constructor(private root: string) { this.directory = resolve(root, ".data/automation-agent/scs_take_rate_ads"); }
  private async read(name: string): Promise<any> {
    try { return JSON.parse(await readFile(resolve(this.directory, name), "utf8")); }
    catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  }
  private async save(name: string, data: any) {
    await mkdir(this.directory, { recursive: true });
    const destination = resolve(this.directory, name), temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, destination);
    if (name === "refresh-job.json" && data?.id) await this.save(`refresh-${data.id}.json`, data);
  }
  async init() {
    this.job = await this.read("refresh-job.json");
    // Recorded statement IDs can be polled after restart; no blind resubmission.
    if (this.job?.status === "running") {
      this.job.status = "interrupted";
      this.job.error = "服务重启，刷新已中断。已提交的 SQL 不会自动重复提交。";
      await this.save("refresh-job.json", this.job);
    }
  }
  close() { this.controller.abort(); }
  async snapshot(rawDate: string) {
    const date = validDate(rawDate);
    let snapshot: Snapshot | null = await this.read(`view-${date}.json`);
    if (!snapshot) {
      const inspection = await this.read("inspection.json");
      const raw = await this.read(`business-log-${date}.json`);
      const airflow = await this.read(`airflow-${date}.json`);
      const ruleDetails = await this.read("rules-snapshot.json");
      const statements = raw?.data?.statements;
      snapshot = { date,
        airflow: { mode: airflow ? "snapshot" : "unavailable", observed_at: airflow?.run?.observed_at ?? null, data: airflow },
        rules: { mode: "snapshot", observed_at: ruleDetails?.observed_at ?? null,
          data: { overview: inspection?.rules?.overview, sheets: ruleDetails?.sheets ?? {}, spreadsheet_id: sheetId } },
        business: { mode: statements ? "snapshot" : "unavailable", observed_at: null, data: statements ? {
          groups: records(statements[0]), details: records(statements[1]), detail_scope: "当天最新 10 条日志（不是全部失败明细）", table,
          session_id: inspection?.business_log?.session_id, statement_ids: [2,3] } : null } };
    }
    const groups = snapshot.business.data?.groups ?? [];
    return { ...snapshot, regions: summarize(groups), job: this.job,
      caveats: ["统计单位是日志行，不是去重商品或接口调用数。", "业务 date 时区尚未确认；没有 dag_run_id，不能确认日志属于某次运行。",
        "Sheet 是当前规则，不能替代历史运行时的规则快照。", "未执行包括规则跳过；不等同于失败。"],
      sources: { airflow: `${airflowBase()}/dags/scs_take_rate_ads/grid`, sheet: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`, table } };
  }
  async start(rawDate: string) {
    const date = validDate(rawDate);
    if (this.active) return this.job;
    this.active = true;
    try {
    const inspection = await this.read("inspection.json");
    const session = process.env.AUTOMATION_DI_SESSION_ID || String(inspection?.business_log?.session_id ?? "");
    if (!/^\d+$/.test(session)) throw new Error("需要配置已有的 AUTOMATION_DI_SESSION_ID。");
    const identity = process.env.AUTOMATION_DI_IDENTITY || "yara.huang";
    this.job = { id: randomUUID(), date, status: "running", phase: "查询 Airflow 和规则", statements: [], notice: [], started_at: stamp(), session, identity };
    await this.save("refresh-job.json", this.job);
    const job = this.job;
    void this.refresh(job).catch(async () => {
      job.status = "failed"; job.error = "刷新异常中断，已记录的 SQL 不会自动重复提交。";
      await this.save("refresh-job.json", job).catch(() => {});
    }).finally(() => { this.active = false; });
    return this.job;
    } catch (e) { this.active = false; throw e; }
  }
  private async di(args: string[], job: Job) {
    let out: { stdout: string; stderr: string };
    try { out = await execute(process.env.AUTOMATION_DI_BIN || resolve(process.env.HOME || "", ".local/bin/di"), args,
      { cwd: this.root, maxBuffer: 8 * 1024 * 1024, timeout: 30000, signal: this.controller.signal }); }
    catch (e: any) {
      // Never expose raw stderr, credentials, or service payloads to browser.
      let error: any;
      try { error = JSON.parse(e.stderr || "{}"); } catch { /* Non-JSON local failure. */ }
      if (error?._notice) { job.notice.push(error._notice); await this.save("refresh-job.json", job); }
      const category = ["validation","auth","network","permission","api","internal","deadline","cost_gate","version_upgrade_required"].includes(error?.error?.type) ? error.error.type : "local";
      throw new Error(e.code === 10 ? "DI 需要人工确认，未自动确认。" : `DI 命令失败（${category}）；检查本机登录、网络及 session 是否过期。提交失败时结果可能未知，请先核对 session。`, { cause: e.code });
    }
    let envelope: any;
    try { envelope = JSON.parse(out.stdout); } catch { throw new Error("DI 返回非 JSON 响应。"); }
    if (envelope._notice) { job.notice.push(envelope._notice); await this.save("refresh-job.json", job); }
    if (args[3] === "execute" && Number.isInteger(envelope.data?.result?.id)) {
      if (!job.statements.includes(envelope.data.result.id)) job.statements.push(envelope.data.result.id);
      await this.save("refresh-job.json", job);
    }
    if (envelope.ok !== true || ![job.identity, `${job.identity}@shopee.com`].includes(envelope.identity)) throw new Error("DI 返回失败或身份与配置不一致。");
    return envelope.data;
  }
  /** Runs a tool from python/agent_backend/tools/airflow.py via python/agent_backend/airflow_cli.py. */
  private async airflow(tool: string, args: Record<string, unknown>) {
    const bundled = resolve(this.root, ".venv-di/bin/python");
    const candidate = process.env.AGENT_PYTHON || (existsSync(bundled) ? bundled : "python3");
    const { stdout } = await execute(candidate.includes("/") ? resolve(this.root, candidate) : candidate,
      ["-m", "agent_backend.airflow_cli", tool, JSON.stringify({ ...args, server: "automation" })], {
        cwd: resolve(this.root, "python"), timeout: 30000, signal: this.controller.signal,
        env: { ...process.env, PYTHONNOUSERSITE: "1", AUTOMATION_AIRFLOW_BASE_URL: airflowBase() } });
    return JSON.parse(stdout);
  }
  private async query(sql: string, job: Job): Promise<Row[]> {
    const env = ["--service-env", "sg"];
    const submitted = await this.di(["livy","interactives","statements","execute",job.session,"--kind","sql","--code",sql,...env], job);
    const id = submitted.result?.id;
    if (!Number.isInteger(id)) throw new Error("DI 提交响应缺少 statement ID；未自动重试。");
    if (!job.statements.includes(id)) job.statements.push(id);
    await this.save("refresh-job.json", job);
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      this.controller.signal.throwIfAborted();
      const data = await this.di(["livy","interactives","statements","get",job.session,String(id),...env], job);
      if (data.result?.state === "available") return records(data.result);
      if (!["waiting","running"].includes(data.result?.state)) throw new Error(`DI statement ${id} 未成功完成。`);
      job.phase = `等待 SQL statement ${id}（${data.result.state}）`;
      await this.save("refresh-job.json", job);
      await new Promise<void>(done => { const timer = setTimeout(done, 3000); timer.unref(); });
    }
    throw new Error(`DI statement ${id} 仍未结束；已保留 session 和 statement ID，不会自动重新提交或取消。`);
  }
  private async refresh(job: Job) {
    const previous = await this.snapshot(job.date);
    const snapshot: Snapshot = { date: job.date, airflow: previous.airflow, rules: previous.rules, business: previous.business };
    const failures: string[] = [];
    try {
      const args = { dag_id: "scs_take_rate_ads", dag_run_id: `scheduled__${job.date}T07:00:00+00:00` };
      const { run } = await this.airflow("airflow_get_run", args);
      const { task } = await this.airflow("airflow_get_task", { ...args, task_id: "scs_take_rate_ads" });
      snapshot.airflow = { mode: "live", observed_at: stamp(), data: { run, task, scope: "当天逻辑时间 15:00 的运行；不代表全天全部运行", log: {status:"unavailable",message:"完整任务日志尚未接入"} } };
    } catch { snapshot.airflow = { ...snapshot.airflow, error: "Airflow 刷新失败，保留旧结果（若有）。" }; failures.push("Airflow"); }
    const token = process.env.AUTOMATION_GSHEET_ACCESS_TOKEN;
    if (token) {
      try {
        const get = async (range: string) => {
          const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([this.controller.signal,AbortSignal.timeout(10000)]), redirect: "error" });
          if (!response.ok) throw new Error("Sheet 查询失败。");
          return response.json();
        };
        const overview = await get("'自动化规则'!A1:I21");
        const sheets: Record<string, any> = {};
        for (const name of ["MY for tail","PH for tail","TH for tail"]) sheets[name] = await get(`'${name}'!A16:AY30`);
        snapshot.rules = { mode: "live", observed_at: stamp(), data: { overview, sheets, spreadsheet_id: sheetId } };
      } catch { snapshot.rules = { ...snapshot.rules, error: "GSheet 刷新失败，保留规则快照。" }; failures.push("GSheet"); }
    } else { snapshot.rules = { ...snapshot.rules, error: "本地 Sheet 授权未配置，使用已读取的规则快照。" }; failures.push("GSheet 未授权"); }
    try {
      job.phase = "查询当天业务汇总"; await this.save("refresh-job.json", job);
      const tomorrow = new Date(`${job.date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
      const where = `date >= '${job.date} 00:00:00' AND date < '${tomorrow.toISOString().slice(0,10)} 00:00:00'`;
      const groups = await this.query(`SELECT region, action_type, status, execution_mode, execution_status, COUNT(*) AS log_rows, MIN(date) AS first_execution_time, MAX(date) AS last_execution_time FROM ${table} WHERE ${where} GROUP BY region, action_type, status, execution_mode, execution_status`, job);
      summarize(groups);
      job.phase = "查询失败明细"; await this.save("refresh-job.json", job);
      const details = await this.query(`SELECT date, region, location, item_id, shop_id, campaign_id, action_type, status, reason, rule_type, rule_conditions, execution_mode, execution_status, execution_result, grass_date, ingestion_timestamp FROM ${table} WHERE ${where} AND execution_status = 'failed' ORDER BY date DESC, region, item_id LIMIT 200`, job);
      snapshot.business = { mode: "live", observed_at: stamp(), data: { groups, details, detail_scope: "当天最新 200 条失败日志，达到上限时明细可能不全", table,
        session_id: job.session, statement_ids: job.statements, where } };
    } catch (e) { snapshot.business = { ...snapshot.business, error: e instanceof Error ? e.message : "DI 查询失败。" }; failures.push("DI"); }
    await this.save(`view-${job.date}.json`, snapshot);
    job.status = failures.length ? "partial" : "completed";
    job.phase = failures.length ? `刷新结束：${failures.join("、")} 未更新` : "所有数据源刷新成功";
    await this.save("refresh-job.json", job);
  }
}
