import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { AppError } from "../session-store.js";

export class RunJavaScriptTool {
  private active = false;
  readonly name = "run_javascript";
  readonly definition = { type: "function" as const, function: {
    name: "run_javascript", description: "Run short JavaScript in a separate Node process after user approval. Filesystem access is limited to the dedicated workspace; output and time are bounded. The full code is shown to the user before approval.",
    parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript source, at most 4,000 characters" } },
      required: ["code"], additionalProperties: false },
  } };
  constructor(private readonly workspace: string) {}

  async execute(args: unknown, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 ||
      typeof (args as { code?: unknown }).code !== "string") {
      throw new AppError("TOOL_INVALID_ARGS", "run_javascript 只接受 code 字符串参数。");
    }
    const code = (args as { code: string }).code;
    if (!code.trim() || code.length > 4_000) throw new AppError("TOOL_INVALID_ARGS", "代码需要 1–4,000 个字符。");
    if (this.active) throw new AppError("TOOL_BUSY", "代码执行一次只允许一个进程。");
    this.active = true;
    try {
    const root = await realpath(this.workspace);
    return await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--max-old-space-size=64", "--permission", `--allow-fs-read=${root}`, `--allow-fs-write=${root}`,
        "--input-type=module", "--eval", code], {
        cwd: root, env: { PATH: process.env.PATH ?? "" }, timeout: 10_000, maxBuffer: 8 * 1024,
        signal, windowsHide: true,
      }, (error, stdout, stderr) => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) {
          const detail = stderr.trim().slice(0, 2_000);
          reject(new AppError("TOOL_EFFECT_UNKNOWN", "代码执行未正常完成，可能已产生副作用，请核对后再决定。\n" +
            (detail || "执行失败或超过 10 秒/16 KiB 输出上限。")));
          return;
        }
        resolve(JSON.stringify({ stdout, stderr, exitCode: 0 }));
      });
    });
    } finally { this.active = false; }
  }
}
