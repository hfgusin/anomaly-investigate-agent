import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { AppError } from "../session-store.js";

function pathParts(path: unknown): string[] {
  if (typeof path !== "string" || !path || path.length > 512) {
    throw new AppError("TOOL_INVALID_PATH", "需要工作区内的相对路径。");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") ||
    part.includes("\\") || part.includes("\0"))) {
    throw new AppError("TOOL_INVALID_PATH", "路径不能包含隐藏文件、上跳或反斜杠。");
  }
  return parts;
}

async function parentDirectory(workspace: string, parts: string[]): Promise<string> {
  const root = await realpath(workspace);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = await lstat(parent).catch(() => { throw new AppError("TOOL_INVALID_PATH", "父目录不存在。"); });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError("TOOL_INVALID_PATH", "父路径必须是普通目录。");
  }
  const resolved = await realpath(parent);
  if (resolved !== root && (relative(root, resolved).startsWith("..") || relative(root, resolved).startsWith("/"))) {
    throw new AppError("TOOL_INVALID_PATH", "目录不在工作区内。");
  }
  return parent;
}

export class ListWorkspaceTool {
  readonly name = "list_workspace";
  readonly definition = { type: "function" as const, function: {
    name: "list_workspace", description: "List visible files and directories in the dedicated workspace, without reading their contents.",
    parameters: { type: "object", properties: { directory: { type: "string", description: "Relative directory; use empty string for workspace root" } },
      required: ["directory"], additionalProperties: false },
  } };
  constructor(private readonly workspace: string) {}

  async execute(args: unknown, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 ||
      typeof (args as { directory?: unknown }).directory !== "string") {
      throw new AppError("TOOL_INVALID_ARGS", "list_workspace 只接受 directory 字符串参数。");
    }
    const directory = (args as { directory: string }).directory;
    const root = await realpath(this.workspace);
    let target = root;
    if (directory) {
      for (const part of pathParts(directory)) {
        target = join(target, part);
        const stat = await lstat(target).catch(() => { throw new AppError("TOOL_NOT_FOUND", "目录不存在。"); });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError("TOOL_INVALID_PATH", "只能列出普通目录。");
      }
    }
    const entries = await readdir(target, { withFileTypes: true });
    signal.throwIfAborted();
    const visible = entries.filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink());
    return JSON.stringify({ directory, entries: visible.slice(0, 100).map((entry) => ({
      name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })), truncated: visible.length > 100 });
  }
}

export class WriteFileTool {
  readonly name = "write_file";
  readonly definition = { type: "function" as const, function: {
    name: "write_file", description: "Create a UTF-8 file in the dedicated workspace, or replace one only with its current SHA-256. Requires user approval before execution.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Relative path in the dedicated workspace" },
      content: { type: "string", description: "New UTF-8 text, at most 6 KiB" },
      mode: { type: "string", enum: ["create", "replace"] },
      expected_sha256: { type: "string", description: "Required in replace mode; get it from read_file" },
    }, required: ["path", "content", "mode"], additionalProperties: false },
  } };
  constructor(private readonly workspace: string) {}

  async execute(args: unknown, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new AppError("TOOL_INVALID_ARGS", "write_file 参数无效。");
    const value = args as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["path", "content", "mode", "expected_sha256"].includes(key)) ||
      typeof value.content !== "string" || !["create", "replace"].includes(String(value.mode))) {
      throw new AppError("TOOL_INVALID_ARGS", "write_file 需要 path、content 和 mode。");
    }
    const content = Buffer.from(value.content, "utf8");
    if (content.byteLength > 6 * 1024) throw new AppError("TOOL_TOO_LARGE", "单次写入最多 6 KiB。");
    const parts = pathParts(value.path);
    const parent = await parentDirectory(this.workspace, parts);
    const path = join(parent, parts.at(-1)!);
    if (value.mode === "create") {
      if (value.expected_sha256 !== undefined) throw new AppError("TOOL_INVALID_ARGS", "创建文件不需要 expected_sha256。");
      const temporary = join(parent, `.mirror-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(content); await file.sync(); await file.close();
        signal.throwIfAborted();
        await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw new AppError("TOOL_EXISTS", "文件已存在；请先读取，再使用 replace。");
          throw error;
        });
      } finally {
        await file.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    } else {
      if (typeof value.expected_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.expected_sha256)) {
        throw new AppError("TOOL_INVALID_ARGS", "替换文件需要 read_file 给出的 expected_sha256。");
      }
      const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new AppError("TOOL_NOT_FOUND", "要替换的文件不存在。");
          throw error;
        });
      let original: Buffer;
      try {
        const stat = await current.stat();
        if (!stat.isFile() || stat.size > 64 * 1024) throw new AppError("TOOL_INVALID_FILE", "只能替换不超过 64 KiB 的普通文件。");
        original = await current.readFile();
      } finally { await current.close(); }
      if (createHash("sha256").update(original).digest("hex") !== value.expected_sha256) {
        throw new AppError("TOOL_CHANGED", "文件内容已变化，请重新读取后再替换。");
      }
      const temporary = join(parent, `.mirror-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
        await file.close();
        signal.throwIfAborted();
        const latest = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let latestContent: Buffer;
        try { latestContent = await latest.readFile(); } finally { await latest.close(); }
        if (createHash("sha256").update(latestContent).digest("hex") !== value.expected_sha256) {
          throw new AppError("TOOL_CHANGED", "文件内容已变化，请重新读取后再替换。");
        }
        await rename(temporary, path);
      } catch (error) { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); throw error; }
    }
    return JSON.stringify({ path: value.path, mode: value.mode, bytes: content.byteLength,
      previousSha256: value.mode === "replace" ? value.expected_sha256 : null,
      sha256: createHash("sha256").update(content).digest("hex") });
  }
}
