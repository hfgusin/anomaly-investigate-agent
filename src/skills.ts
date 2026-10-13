import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "./session-store.js";

export type SelectedSkill = Readonly<{ id: string; version: string; instructions: string; source: string; command: string }>;
const aliases: Record<string, string> = { "multi-hop-research": "research", "multi-hop-research-v2": "research2" };
const reserved = new Set(["new", "reset", "stop", "team", "research", "research2"]);

/** Trusted local instruction files, separate from the model-writable workspace. */
export class SkillRegistry {
  private entries: SelectedSkill[] = [];
  private refreshedAt: string | null = null;
  private error: string | null = null;
  private invalid = new Map<string, string>();
  constructor(private readonly root: string) {
    try { this.refresh(); } catch { /* Keep diagnostics available through the Gateway; selection still fails closed. */ }
  }

  overview() {
    return { skills: this.entries.map(({ instructions, ...entry }) => ({ ...entry, chars: instructions.length })),
      refreshedAt: this.refreshedAt, error: this.error, errors: [...this.invalid].map(([id, message]) => ({ id, message })),
      priority: [".data/skills", "skills"], refreshPolicy: "新 Run 开始执行时自动刷新；已开始 Run 使用持久化快照" };
  }

  refresh() {
    const found = new Map<string, SelectedSkill>();
    const invalid = new Map<string, string>();
    try {
      // A refresh replaces the catalog only after all files validate successfully.
      for (const directory of ["skills", ".data/skills"]) {
        const base = resolve(this.root, directory);
        // Reject linked ancestors, including .data, before touching instructions.
        for (const prefix of directory === "skills" ? ["skills"] : [".data", ".data/skills"]) {
          try { if (lstatSync(resolve(this.root, prefix)).isSymbolicLink()) throw new Error(`${prefix} 不允许符号链接`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        let names: string[];
        try { names = readdirSync(base).sort(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (names.length > 64) throw new Error(`${directory} 最多 64 个条目`);
        for (const id of names) {
          if (id.startsWith(".")) continue;
          try {
          const folder = resolve(base, id);
          const stat = lstatSync(folder);
          if (stat.isSymbolicLink()) throw new Error(`${directory}/${id} 不允许符号链接`);
          if (!stat.isDirectory()) continue;
          if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || (reserved.has(id) && !aliases[id])) {
            throw new Error(`${directory}/${id} 名称无效或占用保留命令`);
          }
          const source = `${directory}/${id}/SKILL.md`;
          const file = resolve(this.root, source);
          const fileStat = lstatSync(file);
          if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 32_000) throw new Error(`${source} 必须是最多 32000 字节的普通文件`);
          const instructions = readFileSync(file, "utf8");
          if (!instructions.trim() || instructions.length > 8_000) throw new Error(`${source} 内容为空或超过 8000 字符`);
          found.set(id, Object.freeze({ id, source, instructions, command: `/${Object.hasOwn(aliases, id) ? aliases[id] : id}`,
            version: createHash("sha256").update(instructions).digest("hex") }));
          invalid.delete(id);
          } catch (error) {
            found.delete(id);
            invalid.set(id, error instanceof Error ? error.message : "Skill 读取失败");
          }
        }
      }
      this.invalid = invalid;
      this.entries = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
      this.refreshedAt = new Date().toISOString(); this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Skill 读取失败";
      throw new AppError("SKILL_REFRESH_FAILED", this.error);
    }
    return this.overview();
  }

  select(input: string): SelectedSkill | undefined {
    const command = input.trim().split(/\s+/u)[0];
    if (!command?.startsWith("/")) return undefined;
    this.refresh();
    const id = Object.keys(aliases).find((id) => `/${aliases[id]}` === command) ?? command.slice(1);
    if (this.invalid.has(id)) throw new AppError("SKILL_INVALID", this.invalid.get(id)!);
    const skill = this.entries.find((entry) => entry.command === command);
    if (skill && input.trim() === command) throw new AppError("SKILL_INPUT_REQUIRED", "请在 Skill 命令后填写任务。");
    if (!skill) throw new AppError("SKILL_NOT_FOUND", `未找到命令 ${command}。可用 Skill：${this.entries.map((entry) => entry.command).join("、") || "无"}`);
    return skill;
  }
}
