import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "./corpus.js";
import { zhResultView } from "./i18n.js";
import { atomicJson, BASE, json, MiniLM, RagError, validateVector, type ModelInfo } from "./model.js";

const PIPELINE = "minilm-ts-character-windows-v1";
export type Parent = { id: string; text: string; content_sha256: string; title: string; section: string[];
  platforms: string[]; kind: string; source_url: string; version: string; review_status: string; language?: string };
type Segment = { id: string; parent_id: string; text: string; embedding_text: string; char_start: number;
  char_end: number; char_basis: string; token_count: number };
type Corpus = { status: string; chunks_sha256: string; run_id: string };
type IndexManifest = { pipeline: string; index_id: string; index_path: string; corpus_hash: string; model: ModelInfo;
  parents: number; segments: number; status: string };
export async function loadCorpus(): Promise<{ manifest: Corpus; parents: Parent[] }> {
  if (!existsSync(join(BASE, "latest.json"))) throw new RagError("CORPUS_NOT_FOUND", "先运行 pnpm rag:prepare。");
  const pointer = await json<{ manifest: string; chunks: string }>(join(BASE, "latest.json"));
  const manifest = await json<Corpus>(pointer.manifest);
  if (manifest.status !== "complete") throw new RagError("CORPUS_PARTIAL", "资料尚未下载完整。");
  const raw = await readFile(pointer.chunks);
  if (sha256(raw) !== manifest.chunks_sha256) throw new RagError("CORPUS_HASH_MISMATCH", "语料哈希不符，请重新 prepare。");
  const parents = raw.toString("utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Parent);
  if (!parents.length || new Set(parents.map(parent => parent.id)).size !== parents.length) throw new RagError("CORPUS_INVALID", "资料为空或 ID 重复。");
  for (const parent of parents) if (sha256(parent.text) !== parent.content_sha256) throw new RagError("CORPUS_HASH_MISMATCH", parent.id);
  return { manifest, parents };
}

/** Split original characters rather than decoding token IDs: source text stays readable and complete. */
function windows(parent: Parent, model: MiniLM): Segment[] {
  const text = parent.text.replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/g, "$1");
  // Code point boundaries prevent cutting an emoji/surrogate pair in half.
  const chars = Array.from(text);
  const offsets = [0]; for (const char of chars) offsets.push(offsets[offsets.length - 1]! + char.length);
  let context = `${parent.title} / ${parent.section.at(-1) ?? ""}`.replace(/[ /]+$/, "");
  const prefix = Array.from(context);
  while (prefix.length && model.count(prefix.join(""), false) > 16) prefix.pop();
  context = prefix.join("");
  const segments: Segment[] = []; let start = 0;
  while (start < chars.length) {
    // Find the longest prefix fitting the body budget; always re-count the final combined input.
    let low = start + 1; let high = Math.min(chars.length, start + 2048); let end = start;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const body = text.slice(offsets[start], offsets[mid]);
      if (model.count(body, false) <= 104 && model.count(context + "\n" + body) <= 128) { end = mid; low = mid + 1; }
      else high = mid - 1;
    }
    if (end <= start) throw new RagError("WINDOW_SPLIT_FAILED", parent.id);
    if (end < chars.length) {
      for (let boundary = end; boundary > start; boundary--) {
        if (/[\n.!?。！？]/u.test(chars[boundary - 1]!) && model.count(text.slice(offsets[start], offsets[boundary]), false) >= 40) { end = boundary; break; }
      }
    }
    const body = text.slice(offsets[start], offsets[end]);
    const embedding = context + "\n" + body;
    const count = model.count(embedding);
    if (count > 128) throw new RagError("WINDOW_SPLIT_FAILED", "窗口 token 上限超出。");
    segments.push({ id: sha256(`${parent.id}:${offsets[start]}:${offsets[end]}`).slice(0, 24), parent_id: parent.id,
      char_start: offsets[start]!, char_end: offsets[end]!, char_basis: "parent_text_with_link_targets_removed",
      token_count: count, text: body, embedding_text: embedding });
    if (end === chars.length) break;
    // Keep a suffix of at most 16 tokens as overlap, while always advancing.
    let overlapStart = end; low = start + 1; high = end;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (model.count(text.slice(offsets[mid], offsets[end]), false) <= 16) { overlapStart = mid; high = mid - 1; }
      else low = mid + 1;
    }
    start = overlapStart;
  }
  return segments;
}
function encode(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(384 * 4); vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4)); return bytes;
}
function decode(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength !== 384 * 4) throw new RagError("INDEX_INVALID_VECTORS", "向量字节数错误。");
  const buffer = Buffer.from(bytes); const vector = Float32Array.from({ length: 384 }, (_, i) => buffer.readFloatLE(i * 4));
  validateVector(vector); return vector;
}

export async function buildIndex(): Promise<void> {
  await mkdir(join(BASE, "indexes"), { recursive: true });
  const lockPath = join(BASE, "index.lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new RagError("INDEX_BUSY", "索引构建正在运行；异常退出后先确认进程已停止，再删除 index.lock。"); });
  let model: MiniLM | undefined; let db: DatabaseSync | undefined; let cache: DatabaseSync | undefined; let staging: string | undefined;
  try {
    const { manifest, parents } = await loadCorpus(); model = await MiniLM.load();
    console.error(`正在按 tokenizer 切分 ${parents.length} 个父片段…`);
    const segments = parents.flatMap(parent => windows(parent, model!));
    if (!segments.length) throw new RagError("NO_WINDOWS", "没有向量窗口。");
    const identity = sha256(manifest.chunks_sha256 + model.info.fingerprint + PIPELINE + sha256(await readFile(new URL(import.meta.url))));
    const path = join(BASE, "indexes", `${identity}.sqlite`); staging = `${path}.${process.pid}.building`;
    db = new DatabaseSync(staging);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE parents (id TEXT PRIMARY KEY, content TEXT NOT NULL); CREATE TABLE segments (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, content TEXT NOT NULL, vector BLOB NOT NULL);");
    const putParent = db.prepare("INSERT INTO parents VALUES (?,?)");
    for (const parent of parents) putParent.run(parent.id, JSON.stringify(parent));
    // Separate cache namespace: Python/ONNX and fp32/q8 vectors must never be mixed.
    cache = new DatabaseSync(join(BASE, "embedding-cache-ts.sqlite"));
    cache.exec("CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL)");
    const find = cache.prepare("SELECT vector FROM vectors WHERE key=?"); const put = cache.prepare("INSERT OR REPLACE INTO vectors VALUES (?,?)");
    const putSegment = db.prepare("INSERT INTO segments VALUES (?,?,?,?)");
    let hits = 0; let encoded = 0; const started = performance.now();
    for (let offset = 0; offset < segments.length; offset += 16) {
      const batch = segments.slice(offset, offset + 16);
      const keys = batch.map(segment => sha256(model!.info.fingerprint + segment.embedding_text));
      const vectors = new Map<number, Float32Array>(); const missing: number[] = [];
      keys.forEach((key, i) => {
        const row = find.get(key);
        if (row) { try { vectors.set(i, decode(row.vector as Uint8Array)); hits++; return; } catch { /* Recompute corrupt cache rows. */ } }
        missing.push(i);
      });
      if (missing.length) {
        const computed = await model.embed(missing.map(i => batch[i]!.embedding_text));
        cache.exec("BEGIN");
        try { missing.forEach((i, j) => { vectors.set(i, computed[j]!); put.run(keys[i]!, encode(computed[j]!)); }); cache.exec("COMMIT"); }
        catch (error) { cache.exec("ROLLBACK"); throw error; }
        encoded += missing.length;
      }
      batch.forEach((segment, i) => putSegment.run(segment.id, segment.parent_id, JSON.stringify(segment), encode(vectors.get(i)!)));
      if (offset % 320 === 0 || offset + 16 >= segments.length) console.error(`向量化 ${Math.min(offset + 16, segments.length)}/${segments.length}，缓存 ${hits}`);
    }
    const metadata = { status: "complete", pipeline: PIPELINE, index_id: identity, index_path: path, corpus_hash: manifest.chunks_sha256,
      corpus_run_id: manifest.run_id, model: model.info, parents: parents.length, segments: segments.length,
      max_observed_tokens: Math.max(...segments.map(segment => segment.token_count)), overlap_tokens_max: 16,
      vector_bytes: segments.length * 384 * 4, build_seconds: Math.round((performance.now() - started) / 10) / 100, encoded, cache_hits: hits };
    db.prepare("INSERT INTO meta VALUES (?,?)").run("manifest", JSON.stringify(metadata));
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new RagError("INDEX_INTEGRITY_ERROR", "SQLite 索引损坏。");
    db.close(); db = undefined; await rename(staging, path); staging = undefined;
    await atomicJson(join(BASE, "index.json"), { ...metadata, database_bytes: (await stat(path)).size });
    console.log(JSON.stringify(metadata, null, 2));
  } finally {
    db?.close(); cache?.close(); await model?.dispose();
    if (staging) await rm(staging, { force: true });
    await lock.close(); await rm(lockPath, { force: true });
  }
}

const glossary: Record<string, string> = { "预算": "budget", "消耗": "spend", "花费": "spend", "进度": "pacing", "出价": "bidding",
  "归因": "attribution", "转化": "conversion", "追踪": "tracking", "回传": "tracking", "素材": "creative", "创意": "creative",
  "疲劳": "fatigue", "受众": "audience", "定向": "targeting", "点击率": "ctr", "每次转化费用": "cpa", "广告支出回报": "roas" };
function terms(text: string): string[] {
  const result: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const [phrase, word] of Object.entries(glossary)) for (let i = 0; i < text.split(phrase).length - 1; i++) result.push(word);
  for (const group of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (group.length === 1) result.push(group);
    else for (let i = 0; i < group.length - 1; i++) result.push(group.slice(i, i + 2));
  }
  return result;
}
export type SearchOptions = { query: string; limit: number; platform?: string; kind?: string };
export type SearchHit = { chunk_id: string; title: string; section: string[]; kind: string; platforms: string[];
  source_url: string; version: string; review_status: string; language: string; rrf_score: number;
  channels: Record<string, { rank: number; score: number }>; matched_window: string; parent_text: string;
  zh: ReturnType<typeof zhResultView> };
export type SearchResult = { query: string; results: SearchHit[]; offline: true; reason?: string; index_id?: string;
  model?: string; runtime?: string; filters?: { platform: string | null; kind: string | null }; note?: string; note_zh?: string };
export async function search(options: SearchOptions): Promise<SearchResult> {
  if (!options.query.trim() || options.query.length > 4000) throw new RagError("INVALID_QUERY", "查询必须非空且不超过 4000 字符。");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10) throw new RagError("INVALID_LIMIT", "limit 必须是 1–10。");
  if (!existsSync(join(BASE, "index.json"))) throw new RagError("INDEX_NOT_FOUND", "先运行 pnpm rag:index。");
  const pointer = await json<IndexManifest>(join(BASE, "index.json"));
  if (pointer.pipeline !== PIPELINE) throw new RagError("INDEX_RUNTIME_CHANGED", "这是旧 Python 索引；运行 pnpm rag:setup 和 pnpm rag:index 创建 TS 索引。");
  const { manifest } = await loadCorpus();
  if (pointer.corpus_hash !== manifest.chunks_sha256) throw new RagError("INDEX_STALE", "语料已更新，请重新 rag:index。");
  const model = await MiniLM.load();
  try {
    if (model.info.fingerprint !== pointer.model.fingerprint) throw new RagError("MODEL_CHANGED", "模型或推理版本发生变化，请重新 rag:index。");
    const queryTokens = model.count(options.query);
    if (queryTokens > 128) throw new RagError("QUERY_TOO_LONG", `问题有 ${queryTokens} tokens，超过 128 上限，请缩短。`);
    const db = new DatabaseSync(pointer.index_path, { readOnly: true });
    let parents: Map<string, Parent>; let rows: { parent: Parent; segment: Segment; vector: Float32Array }[];
    try {
      const stored = JSON.parse(String(db.prepare("SELECT value FROM meta WHERE key='manifest'").get()?.value ?? "null")) as IndexManifest | null;
      if (stored?.index_id !== pointer.index_id || stored?.pipeline !== PIPELINE) throw new RagError("INDEX_MISMATCH", "索引清单不符。");
      parents = new Map(db.prepare("SELECT id,content FROM parents").all().map(row => [String(row.id), JSON.parse(String(row.content)) as Parent]));
      const raw = db.prepare("SELECT parent_id,content,vector FROM segments").all();
      if (parents.size !== pointer.parents || raw.length !== pointer.segments) throw new RagError("INDEX_INCOMPLETE", "索引记录数不符。");
      rows = raw.flatMap(row => {
        const parent = parents.get(String(row.parent_id));
        if (!parent) throw new RagError("INDEX_INCOMPLETE", "父片段缺失。");
        if ((options.platform && !parent.platforms.includes(options.platform) && !parent.platforms.includes("general")) || (options.kind && parent.kind !== options.kind)) return [];
        return [{ parent, segment: JSON.parse(String(row.content)) as Segment, vector: decode(row.vector as Uint8Array) }];
      });
    } finally { db.close(); }
    if (!rows.length) return { query: options.query, results: [], reason: "FILTER_EMPTY", offline: true };
    const [queryVector] = await model.embed([options.query]);
    const dense = rows.map(row => row.vector.reduce((sum, value, i) => sum + value * queryVector![i]!, 0));
    const counts = rows.map(row => { const count = new Map<string, number>(); for (const term of terms(row.segment.embedding_text)) count.set(term, (count.get(term) ?? 0) + 1); return count; });
    const lengths = counts.map(count => [...count.values()].reduce((a, b) => a + b, 0));
    const average = Math.max(1, lengths.reduce((a, b) => a + b, 0) / rows.length);
    const queryTerms = [...new Set(terms(options.query))];
    const df = new Map(queryTerms.map(term => [term, counts.filter(count => count.has(term)).length]));
    const sparse = counts.map((count, i) => queryTerms.reduce((sum, term) => {
      const tf = count.get(term) ?? 0; const frequency = df.get(term)!;
      return sum + (tf ? Math.log(1 + (rows.length - frequency + 0.5) / (frequency + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * lengths[i]! / average)) : 0);
    }, 0));
    const fusion = new Map<string, { rrf: number; index: number; channels: Record<string, { rank: number; score: number }> }>();
    for (const [channel, values] of [["dense", dense], ["bm25", sparse]] as const) {
      const seen = new Set<string>(); let rank = 0;
      const order = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
      for (const index of order) {
        if (channel === "bm25" && values[index]! <= 0) break;
        const id = rows[index]!.parent.id; if (seen.has(id)) continue;
        seen.add(id); if (++rank > 50) break;
        const hit = fusion.get(id) ?? { rrf: 0, index, channels: {} };
        hit.rrf += 1 / (60 + rank); hit.channels[channel] = { rank, score: Number(values[index]!.toFixed(6)) };
        if (channel === "dense") hit.index = index;
        fusion.set(id, hit);
      }
    }
    const results = [...fusion].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, options.limit).map(([id, hit]) => {
      const { parent, segment } = rows[hit.index]!;
      const language = parent.language ?? "en";
      return { chunk_id: id, title: parent.title, section: parent.section, kind: parent.kind, platforms: parent.platforms,
        source_url: parent.source_url, version: parent.version, review_status: parent.review_status, language,
        rrf_score: Number(hit.rrf.toFixed(6)), channels: hit.channels, matched_window: segment.text, parent_text: parent.text,
        zh: zhResultView(language, parent.title, parent.section, parent.kind, parent.platforms, parent.review_status, segment.text) };
    });
    return { query: options.query, index_id: pointer.index_id, model: model.info.name, runtime: model.info.runtime, offline: true,
      filters: { platform: options.platform ?? null, kind: options.kind ?? null }, results,
      note: "相关性分数不是事实可信度；结果为检索候选，社区规则与模拟案例需要核对。",
      note_zh: "排序分数不代表事实正确；每条结果的 zh 字段提供中文标签与（英文语料时的）术语对照，完整翻译需自行阅读 matched_window 或接入翻译模型。" };
  } finally { await model.dispose(); }
}
