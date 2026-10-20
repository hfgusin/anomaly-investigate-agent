import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "./session-store.js";
import type { ToolRisk } from "./tool-policy.js";

export type PythonToolEntry = { definition: { type: "function"; function: { name: string; [key: string]: unknown } }; risk: ToolRisk;
  skills: string[]; label: string; autoApprove: boolean; budgetGroup: "query" | "record" };

export function readPythonToolCatalog(root: string, env: NodeJS.ProcessEnv): PythonToolEntry[] {
  const bundled = resolve(root, ".venv-di/bin/python");
  const candidate = env.AGENT_PYTHON || (existsSync(bundled) ? bundled : "python3");
  const result = spawnSync(candidate.includes("/") ? resolve(root, candidate) : candidate,
    ["-m", "agent_backend.catalog"], { cwd: resolve(root, "python"), env: { ...process.env, ...env, PYTHONNOUSERSITE: "1" },
      encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new AppError("INVALID_CONFIG", "Python 工具目录加载失败；检查 AGENT_PYTHON、Python 依赖和 tools/__init__.py。");
  try {
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.some(e => e.definition?.type !== "function" ||
        typeof e.definition.function?.name !== "string" || !["read", "network_read", "write", "execute"].includes(e.risk) ||
        !Array.isArray(e.skills) || typeof e.label !== "string" || typeof e.autoApprove !== "boolean" ||
        !["query", "record"].includes(e.budgetGroup))) throw new Error();
    return entries;
  } catch { throw new AppError("INVALID_CONFIG", "Python 工具目录格式无效。"); }
}
