import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkSections, classify, googleArticle, markdownSections, sha256 } from "./corpus.js";

type Repo = { id: string; repository: string; commit: string; license: string; include: string[]; exclude: string[]; kind: string };
type Page = { id: string; url: string; topics: string[] };
type Document = {
  id: string; source_id: string; source_url: string; source_path: string; title: string; kind: string;
  license: string; license_file: string; version: string; fetched_at: string; source_updated_at: string | null;
  raw_path: string; clean_path: string; raw_sha256: string; clean_sha256: string;
  platforms: string[]; topics: string[]; language: string; removed_sections: string[];
  review_status: "unreviewed"; chunk_count: number;
};
type Chunk = {
  id: string; document_id: string; source_id: string; title: string; section: string[];
  source_url: string; source_path: string; license: string; license_file: string; version: string;
  fetched_at: string; source_updated_at: string | null; platforms: string[]; topics: string[]; language: string;
  kind: string; review_status: "unreviewed"; instruction_policy: "data_only";
  section_line_start: number; section_line_end: number; oversized: boolean; text: string; content_sha256: string;
  duplicate_sources: Array<{ document_id: string; source_url: string; section: string[] }>;
};
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});

async function download(url: string): Promise<string> {
  const target = new URL(url);
  if (target.origin !== "https://developers.google.com" || !target.pathname.startsWith("/google-ads/api/docs/")) throw new Error("PAGE_URL_NOT_ALLOWED");
  const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(20000), headers: { "User-Agent": "OpenClawMirror-Corpus/1.0", Accept: "text/html" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP_${response.status}`); }
  if (!response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel(); throw new Error("NOT_HTML"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_RESPONSE");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("PAGE_TOO_LARGE");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts).toString("utf8");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--offline")) throw new Error("只支持 --offline（用已下载的原文重新清洗）。");
  const offline = args.includes("--offline");
  const configPath = join(projectRoot, "data/ads-rag/sources.json");
  const configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText) as { schema_version: number; repositories: Repo[]; pages: Page[] };
  if (config.schema_version !== 1) throw new Error("SOURCE_SCHEMA_UNSUPPORTED");
  const base = join(projectRoot, ".data/ads-rag");
  await mkdir(base, { recursive: true });
  const lockPath = join(base, "prepare.lock");
  // Exclusive lock prevents two prepares from publishing conflicting pointers.
  const { open, unlink } = await import("node:fs/promises");
  const lock = await open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("另一个 prepare 正在执行；若进程已退出，删除 .data/ads-rag/prepare.lock 后再运行。");
    throw error;
  });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const output = join(base, "snapshots", runId);
  const documents: Document[] = []; const chunks: Chunk[] = [];
  const duplicates = new Map<string, Chunk>();
  const failures: Array<{ source_id: string; path: string; code: string }> = [];
  const selection: Array<{ source_id: string; path: string; selected: boolean; reason: string }> = [];
  const sourceRecords: Array<Record<string, unknown>> = [];
  const errorCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message : error instanceof Error && /timeout/i.test(error.name) ? "DOWNLOAD_TIMEOUT" : "SOURCE_PROCESSING_FAILED";
  const save = async (path: string, body: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body, "utf8"); };

  const addDocument = async (meta: Omit<Document, "title" | "clean_sha256" | "clean_path" | "platforms" | "topics" | "language" | "removed_sections" | "review_status" | "chunk_count">,
    markdown: string, officialTopics?: string[]) => {
    const parsed = markdownSections(markdown);
    if (!parsed.sections.length) throw new Error("NO_USABLE_SECTIONS");
    const title = parsed.title || meta.source_path;
    const clean = parsed.sections.map(section => [section.headings.map((h, i) => `${"#".repeat(i + 1)} ${h}`).join("\n"), ...section.blocks].filter(Boolean).join("\n\n")).join("\n\n");
    const labels = classify(`${title}\n${clean}`);
    if (meta.kind === "official_documentation") labels.platforms = ["google"];
    if (officialTopics) labels.topics = officialTopics;
    const cleanPath = join(output, "clean", `${meta.id}.md`);
    await save(cleanPath, `${clean}\n`);
    const document: Document = { ...meta, title, clean_path: cleanPath, clean_sha256: sha256(`${clean}\n`), ...labels,
      removed_sections: parsed.removedSections, review_status: "unreviewed", chunk_count: 0 };
    for (const section of chunkSections(parsed.sections)) {
      const contentHash = sha256(section.text);
      // Do not merge official rules with community advice or synthetic cases.
      const duplicateKey = `${document.kind}:${document.platforms.slice().sort().join(",")}:${contentHash}`;
      const existing = duplicates.get(duplicateKey);
      if (existing) { existing.duplicate_sources.push({ document_id: document.id, source_url: document.source_url, section: section.headings }); continue; }
      const chunk: Chunk = {
        id: sha256(`${document.id}:${section.headings.join("/")}:${contentHash}`).slice(0, 24),
        document_id: document.id, source_id: document.source_id, title: document.title, section: section.headings,
        source_url: document.source_url, source_path: document.source_path, license: document.license, license_file: document.license_file,
        version: document.version, fetched_at: document.fetched_at, source_updated_at: document.source_updated_at,
        platforms: document.platforms, topics: document.topics, language: document.language, kind: document.kind,
        review_status: "unreviewed", instruction_policy: "data_only", section_line_start: section.lineStart, section_line_end: section.lineEnd,
        oversized: section.oversized, text: section.text, content_sha256: contentHash, duplicate_sources: [],
      };
      duplicates.set(duplicateKey, chunk); chunks.push(chunk); document.chunk_count++;
    }
    documents.push(document);
  };

  try {
    await mkdir(output, { recursive: true });
    for (const repo of config.repositories) {
      console.log(`读取仓库 ${repo.id} @ ${repo.commit.slice(0, 12)}`);
      try {
        if (!/^[a-z0-9-]+$/.test(repo.id) || !/^https:\/\/github\.com\/[\w-]+\/[\w.-]+\.git$/.test(repo.repository) || !/^[a-f0-9]{40}$/.test(repo.commit)) throw new Error("INVALID_SOURCE_CONFIG");
        const cache = join(base, "cache", repo.id);
        if (!existsSync(join(cache, ".git"))) {
          if (offline) throw new Error("OFFLINE_CACHE_MISSING");
          await mkdir(cache, { recursive: true }); git(cache, "init", "--quiet");
        }
        try { git(cache, "cat-file", "-e", `${repo.commit}^{commit}`); }
        catch { if (offline) throw new Error("OFFLINE_VERSION_MISSING"); git(cache, "fetch", "--depth", "1", repo.repository, repo.commit); }
        const license = git(cache, "show", `${repo.commit}:LICENSE`);
        if (repo.license !== "MIT" || !license.startsWith("MIT License") || !license.includes("Permission is hereby granted")) throw new Error("LICENSE_NOT_CONFIRMED");
        const licensePath = join(output, "licenses", `${repo.id}-MIT.txt`); await save(licensePath, license);
        const publishedAt = git(cache, "show", "-s", "--format=%cI", repo.commit).trim();
        const fetchedAt = new Date().toISOString();
        sourceRecords.push({ id: repo.id, repository: repo.repository, commit: repo.commit, commit_at: publishedAt,
          acquired_at: fetchedAt, acquisition: offline ? "local_git_cache" : "git_cache_or_fetch", license: "MIT", license_file: licensePath, license_sha256: sha256(license) });
        const tree = git(cache, "ls-tree", "-r", repo.commit).trim().split("\n");
        for (const entry of tree) {
          const match = /^(\d+) blob [a-f0-9]+\t(.+)$/.exec(entry);
          if (!match) continue;
          const mode = match[1]!; const path = match[2]!;
          if (!path.endsWith(".md")) continue;
          const reason = !repo.include.some(prefix => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix) ? "outside_selected_topics"
            : repo.exclude.some(part => path.includes(part)) ? "assets_or_evaluation"
            : mode !== "100644" && mode !== "100755" ? "not_regular_file" : "included";
          selection.push({ source_id: repo.id, path, selected: reason === "included", reason });
          if (reason !== "included") continue;
          try {
            const raw = git(cache, "show", `${repo.commit}:${path}`);
            const rawPath = join(output, "raw", repo.id, path); await save(rawPath, raw);
            await addDocument({ id: `${repo.id}-${sha256(path).slice(0, 16)}`, source_id: repo.id,
              source_url: `${repo.repository.slice(0, -4)}/blob/${repo.commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
              source_path: path, kind: repo.id === "diagnosis" && path.startsWith("examples/") ? "synthetic_case" : repo.kind,
              license: "MIT", license_file: licensePath, version: repo.commit, fetched_at: fetchedAt, source_updated_at: publishedAt,
              raw_path: rawPath, raw_sha256: sha256(raw) }, raw);
          } catch (error) { failures.push({ source_id: repo.id, path, code: errorCode(error) }); }
        }
        if (!documents.some(document => document.source_id === repo.id)) throw new Error("NO_SELECTED_DOCUMENTS");
      } catch (error) { failures.push({ source_id: repo.id, path: repo.repository, code: errorCode(error) }); }
    }
    for (const page of config.pages) {
      console.log(`下载官方文档 ${page.id}${offline ? "（离线缓存）" : ""}`);
      try {
        if (!/^[a-z0-9-]+$/.test(page.id)) throw new Error("INVALID_SOURCE_CONFIG");
        const cachePath = join(base, "cache", "pages", `${page.id}.json`);
        const cached = offline ? JSON.parse(await readFile(cachePath, "utf8")) as { url: string; html: string; fetched_at: string; sha256: string } : undefined;
        if (cached && (cached.url !== page.url || sha256(cached.html) !== cached.sha256)) throw new Error("OFFLINE_CACHE_MISMATCH");
        const html = cached ? cached.html : await download(page.url);
        const fetchedAt = cached?.fetched_at ?? new Date().toISOString();
        const article = googleArticle(html);
        const version = `sha256:${sha256(html)}`;
        const rawPath = join(output, "raw", "google", `${page.id}.html`); await save(rawPath, html);
        const licensePath = join(output, "licenses", `${page.id}.txt`);
        await save(licensePath, `Source: ${page.url}\nFetched: ${fetchedAt}\nText: CC BY 4.0 (except otherwise noted)\nCode samples: Apache 2.0\nEvidence: ${article.licenseEvidence}\nFull license: https://creativecommons.org/licenses/by/4.0/legalcode\nPolicies: https://developers.google.com/terms/site-policies\n`);
        await addDocument({ id: page.id, source_id: "google", source_url: page.url, source_path: page.id, kind: "official_documentation",
          license: "CC-BY-4.0-text; Apache-2.0-code; exceptions-as-noted", license_file: licensePath, version, fetched_at: fetchedAt,
          source_updated_at: article.updated, raw_path: rawPath, raw_sha256: sha256(html) }, article.markdown, page.topics);
        sourceRecords.push({ id: page.id, url: page.url, version, acquired_at: fetchedAt, updated_at: article.updated,
          license: "CC-BY-4.0-text; Apache-2.0-code; exceptions-as-noted", license_evidence: article.licenseEvidence, license_file: licensePath });
        if (!cached) await save(cachePath, JSON.stringify({ url: page.url, html, fetched_at: fetchedAt, sha256: sha256(html) }));
      } catch (error) { failures.push({ source_id: "google", path: page.url, code: errorCode(error) }); }
    }
    const chunksText = chunks.map(chunk => JSON.stringify(chunk)).join("\n") + (chunks.length ? "\n" : "");
    const pipelineSourceHash = sha256((await readFile(join(projectRoot, "src/ads-rag/corpus.ts"), "utf8")) + "\n" + (await readFile(join(projectRoot, "src/ads-rag/prepare.ts"), "utf8")));
    const manifest = { schema_version: 1, run_id: runId, status: failures.length ? "partial" : "complete", created_at: new Date().toISOString(),
      config_sha256: sha256(configText), pipeline_version: "ads-corpus-v1", output, mode: offline ? "offline" : "online",
      pipeline_source_sha256: pipelineSourceHash,
      classification_method: "keyword_document_level_unreviewed", chunking: { target_characters: 2200, unit: "section_and_complete_blocks", oversized_policy: "preserve_and_flag", deduplication: "exact_text_same_kind_and_platforms" },
      source_records: sourceRecords, documents, selection, failures,
      counts: { documents: documents.length, chunks: chunks.length, characters: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
        oversized_chunks: chunks.filter(chunk => chunk.oversized).length, duplicate_chunks: chunks.reduce((sum, chunk) => sum + chunk.duplicate_sources.length, 0),
        by_source: Object.fromEntries([...new Set(documents.map(doc => doc.source_id))].map(id => [id, { documents: documents.filter(doc => doc.source_id === id).length, chunks: chunks.filter(chunk => chunk.source_id === id).length }])) },
      chunks_sha256: sha256(chunksText) };
    await save(join(output, "chunks.jsonl"), chunksText);
    await save(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const samples: Chunk[] = [];
    for (const id of ["google", "diagnosis", "corey", "mbfinotti"]) {
      const candidates = chunks.filter(chunk => chunk.source_id === id);
      const seen = new Set<string>();
      for (const chunk of candidates) {
        if (seen.has(chunk.document_id)) continue;
        seen.add(chunk.document_id); samples.push(chunk);
        if (seen.size === 3) break;
      }
    }
    const review = `# 广告知识库语料检查\n\n状态：${manifest.status}；${documents.length} 篇文档，${chunks.length} 个片段。\n\n这是下载与切块结果，尚未建向量索引或接入 Agent。所有社区经验与模拟案例待人工审核。\n\n` +
      `## 如何检查\n\n1. 看引用来源与版本是否真实。\n2. 看章节条件、数字和表格是否完整。\n3. 看平台标签是否过宽（自动关键词分类）。\n4. 看社区门槛是否有适用条件，模拟案例是否被误当成真实结果。\n\n` +
      `## 文档索引\n\n` + documents.map(doc => `- [${doc.title}](${doc.clean_path}) — ${doc.source_id} / ${doc.kind} / ${doc.language}；${doc.chunk_count} 个新片段；[来源](${doc.source_url})`).join("\n") +
      `\n\n## 失败记录\n\n${failures.length ? failures.map(f => `- ${f.path}: ${f.code}`).join("\n") : "无。"}\n\n## 片段样例\n\n` +
      samples.map(chunk => `### ${chunk.title} / ${chunk.section.at(-1) ?? "正文"}\n\n类型：${chunk.kind}；平台：${chunk.platforms.join(", ")}；ID：${chunk.id}\n\n[来源](${chunk.source_url})\n\n${chunk.text}\n`).join("\n---\n\n");
    await save(join(output, "review.md"), review);
    const pointer = { run_id: runId, status: manifest.status, manifest: join(output, "manifest.json"), chunks: join(output, "chunks.jsonl"), review: join(output, "review.md") };
    await save(join(base, "latest.json.tmp"), JSON.stringify(pointer, null, 2) + "\n");
    await rename(join(base, "latest.json.tmp"), join(base, "latest.json"));
    console.log(JSON.stringify({ ...pointer, counts: manifest.counts, failures }, null, 2));
    if (failures.length || !chunks.length) process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`语料准备失败：${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 250) : "未知错误"}。已有快照保留。`);
    process.exitCode = 1;
  });
}
