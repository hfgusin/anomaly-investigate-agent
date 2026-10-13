import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const TIME_ZONE = "Asia/Shanghai";
const RETRY_AFTER_MS = 30 * 60_000;

export type DailyScanResult = {
  date: string; start_date: string; end_date: string; attempted_at: string;
  status: "completed" | "failed"; error?: string; result?: Record<string, unknown>;
};
export type ScanRunner = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

function shanghaiHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(now));
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/** 每天北京时间 hour 点后扫描一次 D-5～D0 的失败任务；只读，不排查、不写 GSheet。 */
export class DailyScan {
  private readonly directory: string;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<DailyScanResult> | undefined;

  constructor(private readonly root: string, private readonly runner: ScanRunner = pythonRunner(root),
    private readonly now: () => Date = () => new Date()) {
    this.directory = resolve(root, ".data/daily-scan");
  }

  async latest(): Promise<DailyScanResult | null> {
    try { return JSON.parse(await readFile(resolve(this.directory, "latest.json"), "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  }

  scan(): Promise<DailyScanResult> {
    this.running ??= this.execute().finally(() => { this.running = undefined; });
    return this.running;
  }

  async due(hour: number): Promise<boolean> {
    const now = this.now();
    if (shanghaiHour(now) < hour || this.running) return false;
    const latest = await this.latest();
    if (latest?.date !== shanghaiDate(now)) return true;
    return latest.status === "failed" && now.getTime() - Date.parse(latest.attempted_at) > RETRY_AFTER_MS;
  }

  start(hour = 9, intervalMs = 10 * 60_000) {
    const tick = () => { void this.due(hour).then(due => due ? this.scan() : undefined).catch(() => {}); };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  close() { clearInterval(this.timer); }

  private async execute(): Promise<DailyScanResult> {
    const now = this.now(), date = shanghaiDate(now);
    const args = { start_date: daysBefore(date, 5), end_date: date, owner: "yara", time_zone: TIME_ZONE };
    const base = { date, start_date: args.start_date, end_date: args.end_date, attempted_at: now.toISOString() };
    let scan: DailyScanResult;
    try { scan = { ...base, status: "completed", result: await this.runner(args) }; }
    catch (error) { scan = { ...base, status: "failed", error: error instanceof Error ? error.message : "扫描失败" }; }
    await mkdir(this.directory, { recursive: true });
    for (const name of [`${date}.json`, "latest.json"]) {
      const destination = resolve(this.directory, name), temporary = `${destination}.tmp`;
      await writeFile(temporary, JSON.stringify(scan, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, destination);
    }
    return scan;
  }
}

function pythonRunner(root: string): ScanRunner {
  return async (args) => {
    const bundled = resolve(root, ".venv-di/bin/python");
    const candidate = process.env.AGENT_PYTHON || (existsSync(bundled) ? bundled : "python3");
    try {
      const { stdout } = await execute(candidate.includes("/") ? resolve(root, candidate) : candidate,
        ["-m", "agent_backend.airflow_cli", "airflow_scan_failures", JSON.stringify({ ...args, server: "automation" })],
        { cwd: resolve(root, "python"), timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONNOUSERSITE: "1" } });
      return JSON.parse(stdout);
    } catch (error: any) {
      // airflow_cli 只把 ToolException 的中文说明写到 stderr，不含凭据。
      throw new Error(String(error.stderr || "").trim().split("\n").at(-1) || "扫描进程失败或超时。");
    }
  };
}
