import { sourceHash } from "./source-hash.js";
import { run } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GATEWAY_LIMITS, DEFAULT_MODEL_LIMIT } from "./rate-limit.js";
import { caseStatus, type Evidence, type Observation, type VerificationCase, type VerificationReport } from "./verification-report.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function category(name: string, file: string): string {
  if (file.includes("multi-agent")) return "Multi-Agent";
  if (/\b(?:rate|quota|limit)\b|并发上限/iu.test(name) || file.includes("rate-limit")) return "限流";
  if (/SIGKILL|crash|restart|recovery|recover|shutdown|cancel|interrupt|fault injection|timeout/iu.test(name)) return "故障与恢复";
  if (/concurr|parallel|ordered|queue|idempot|same path|duplicate|independently/iu.test(name)) return "并发与幂等";
  if (/reject|block|symlink|traversal|permission|stale hash|effect|script failure/iu.test(name)) return "安全";
  if (/memory|summary/iu.test(name)) return "记忆";
  if (/hotpot|research|citation|evaluation/iu.test(name + file)) return "研究基准";
  return "基础协议与场景";
}


function failure(error: unknown): { code: string; reason: string; blocked: boolean } {
  const chain: string[] = []; let code = "ASSERTION_FAILED";
  let current = error as { message?: string; code?: string; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current.message) chain.push(current.message);
    if (current.code && current.code !== "ERR_TEST_FAILURE") code = current.code;
    current = current.cause as typeof current;
  }
  const reason = chain.join("\n").slice(0, 4000) || "测试未正常完成。";
  return { code, reason, blocked: /listen EPERM|operation not permitted.*127\.0\.0\.1|ENOTFOUND/iu.test(reason) };
}

export async function verify(repeats: number): Promise<VerificationReport> {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("重复次数必须为 1–10。");
  const fingerprint = sourceHash(root);
  const startedAt = new Date().toISOString();
  const cases = new Map<string, VerificationCase>();
  const files = readdirSync(join(root, "tests")).filter((file) => file.endsWith(".test.mjs")).sort().map((file) => join(root, "tests", file));
  for (let iteration = 1; iteration <= repeats; iteration++) {
    const evidence = new Map<string, Evidence>();
    const observations: Array<{ key: string; observation: Observation }> = [];
    const stream = run({ files, concurrency: 4, isolation: "process", timeout: 15_000 });
    for await (const event of stream) {
      if (event.type === "test:diagnostic") {
        try {
          const entry = JSON.parse(event.data.message);
          if (entry.kind === "acceptance-evidence" && typeof entry.name === "string" && Array.isArray(entry.trace) && ["input", "config", "expected", "actual"].every((key) => Object.hasOwn(entry, key))) {
            evidence.set(entry.name, entry);
          }
        } catch { /* Ordinary diagnostics are not structured evidence. */ }
      }
      if (event.type !== "test:pass" && event.type !== "test:fail") continue;
      const data = event.data;
      if (data.details.type === "suite") continue;
      const file = data.file ? relative(root, data.file) : "unknown";
      const key = `${file}:${data.name}`;
      if (!cases.has(key)) cases.set(key, { id: createHash("sha256").update(key).digest("hex").slice(0, 20),
        file, name: data.name, category: category(data.name, file), observations: [] });
      const problem = event.type === "test:fail" ? failure(event.data.details.error) : null;
      const status = data.skip || data.todo ? "skipped" : problem ? problem.blocked ? "blocked" : "failed" : "passed";
      observations.push({ key, observation: { iteration, status, durationMs: data.details.duration_ms,
        failureCode: problem?.code ?? null, failureReason: problem?.reason ?? null } });
    }
    for (const { key, observation } of observations) {
      const item = cases.get(key)!;
      const entry = evidence.get(item.name);
      if (entry) observation.evidence = entry;
      item.observations.push(observation);
    }
    process.stdout.write(`验收第 ${iteration}/${repeats} 轮：${observations.filter((item) => item.observation.status === "passed").length}/${observations.length} 通过\n`);
  }
  if (sourceHash(root) !== fingerprint) throw new Error("验收期间源文件发生变化，请重新运行。");
  return { schemaVersion: 1, scope: "受控工程回归；不调用真实模型，不代表问答质量或生产吞吐量", startedAt,
    finishedAt: new Date().toISOString(), repeats, sourceSha256: fingerprint,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    configuration: { gatewayDefaults: DEFAULT_GATEWAY_LIMITS, modelDefaults: DEFAULT_MODEL_LIMIT,
      note: "场景使用各自的受控配置；带结构化证据的场景保存确切输入与配置。没有加载用户 .env。" },
    cases: [...cases.values()] };
}

async function main() {
  const args = process.argv.slice(2);
  const repeats = args.length === 0 ? 1 : args.length === 2 && args[0] === "--repeat" ? Number(args[1]) : NaN;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("用法：pnpm verify [--repeat 1–10]");
  const report = await verify(repeats);
  const directory = join(root, ".data/verification"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = JSON.stringify(report, null, 2);
  const temporary = join(directory, `latest-${randomUUID()}.tmp`); writeFileSync(temporary, output, { mode: 0o600 });
  renameSync(temporary, join(directory, "latest.json"));
  writeFileSync(join(directory, `${report.startedAt.replace(/[:.]/gu, "-")}.json`), output, { mode: 0o600 });
  process.stdout.write(`报告：${join(directory, "latest.json")}\n`);
  if (!report.cases.length || report.cases.some((item) => caseStatus(item, repeats) !== "passed")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`验收失败：${error instanceof Error ? error.message : "未知错误"}\n`); process.exitCode = 1; });
}
