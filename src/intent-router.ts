import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type Route = { route: "daily-check" | "ads-check" | "source-lookup" | "general" | "clarify" | "out-of-scope"; reason: string; question?: string | null };
export type IntentRouter = (input: string, history?: Array<{ role: "user" | "assistant"; content: string }>) => Promise<Route>;

export function pythonRouter(root: string): IntentRouter {
  return async (input, history = []) => {
    const bundled = resolve(root, ".venv-di/bin/python");
    const candidate = process.env.AGENT_PYTHON || (existsSync(bundled) ? bundled : "python3");
    const execution = execute(candidate.includes("/") ? resolve(root, candidate) : candidate,
      ["-m", "agent_backend.router"],
      { cwd: resolve(root, "python"), timeout: 95_000, env: { ...process.env, PYTHONNOUSERSITE: "1" } });
    execution.child.stdin!.end(JSON.stringify({ text: input, history }));
    const { stdout } = await execution;
    return JSON.parse(stdout) as Route;
  };
}
