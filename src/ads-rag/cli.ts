import { existsSync } from "node:fs";
import { writeFile, rename, rm } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load config before importing model.ts, whose model path depends on environment settings.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (existsSync(join(root, ".env"))) loadEnvFile(join(root, ".env"));
const { atomicJson, BASE, RagError, setupModel } = await import("./model.js");
const { buildIndex, search } = await import("./index.js");
const { answerChinese, renderChineseAnswer } = await import("./answer.js");

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "setup" && !args.length) await setupModel();
  else if (command === "index" && !args.length) await buildIndex();
  else if (command === "search") {
    const query = args.shift(); if (!query) throw new RagError("INVALID_QUERY", "需要一个用引号括起的问题。");
    let raw = false;
    const options: { query: string; limit: number; platform?: string; kind?: string } = { query, limit: 5 };
    const platforms = ["google", "meta", "tiktok", "linkedin", "programmatic", "general"];
    const kinds = ["official_documentation", "community_methodology", "synthetic_case"];
    while (args.length) {
      const flag = args.shift();
      if (flag === "--raw") { raw = true; continue; }
      const value = args.shift();
      if (!value) throw new RagError("INVALID_ARGUMENT", `${flag} 缺少值。`);
      if (flag === "--limit" && /^\d+$/.test(value)) options.limit = Number(value);
      else if (flag === "--platform" && platforms.includes(value)) options.platform = value;
      else if (flag === "--kind" && kinds.includes(value)) options.kind = value;
      else throw new RagError("INVALID_ARGUMENT", `不支持的参数：${flag} ${value}`);
    }
    const retrievalStarted = performance.now();
    console.error("[1/2] 本地检索中：加载模型、匹配资料…");
    const result = await search(options);
    console.error(`[1/2] 本地检索完成：${((performance.now() - retrievalStarted) / 1000).toFixed(1)} 秒，命中 ${result.results.length} 条资料。`);
    await atomicJson(join(BASE, "last-search.json"), { ...result, generation: { status: raw ? "not_requested" : "pending" } });
    // Clear the previous answer so a failed/new search cannot leave a stale answer presented as current.
    await rm(join(BASE, "last-answer.md"), { force: true });
    if (!raw) {
      try {
        const answer = await answerChinese(result);
        const markdown = renderChineseAnswer(result.query, answer);
        await atomicJson(join(BASE, "last-search.json"), { ...result, generation: { status: "completed" }, answer_zh: answer });
        const path = join(BASE, "last-answer.md"); const temp = `${path}.${process.pid}.tmp`;
        try { await writeFile(temp, markdown, "utf8"); await rename(temp, path); } finally { await rm(temp, { force: true }); }
        console.log(markdown);
        console.error(`中文回答已保存：${path}`);
      } catch (error) {
        await atomicJson(join(BASE, "last-search.json"), { ...result, generation: { status: "failed", code: error instanceof RagError ? error.code : "RAG_FAILED" } });
        throw error;
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (raw && result.results.length) {
      console.error("\n—— 中文导读（字段说明与对照，见 JSON 内 zh）——\n");
      console.error(`问题：${result.query}\n`);
      result.results.forEach((row, i) => {
        const z = row.zh;
        console.error(`【${i + 1}】${z.kind} · ${z.platforms.join("、")}`);
        console.error(`标题：${z.title}`);
        console.error(`章节：${z.section_path}`);
        console.error(`来源：${row.source_url} · ${z.review_status}`);
        if (z.body_note) console.error(z.body_note);
        console.error(`对照阅读：\n${z.matched_window}\n`);
      });
    }
  } else throw new RagError("USAGE", '用法：pnpm rag:setup | pnpm rag:index | pnpm rag:search "问题" [--limit 3] [--platform meta] [--kind official_documentation] [--raw]');
} catch (error) {
  console.error(error instanceof RagError ? `[${error.code}] ${error.message}` : `[RAG_FAILED] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
