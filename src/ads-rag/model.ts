import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { sha256 } from "./corpus.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BASE = join(ROOT, ".data/ads-rag");
export const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
const WEIGHT_HASH = "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc";
export const MODEL_PATH = resolve(process.env.RAG_ONNX_MODEL_PATH ?? join(BASE, "models/minilm-q8"));
export class RagError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n"); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest("hex");
}

/** Only setup accesses the network. Files are pinned and weights verified before publication. */
export async function setupModel(): Promise<void> {
  await mkdir(MODEL_PATH, { recursive: true });
  const lockPath = join(MODEL_PATH, "setup.lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new RagError("MODEL_SETUP_BUSY", "模型下载正在运行；异常退出后确认进程已停止再删除 setup.lock。"); });
  try {
    const hashes: Record<string, string> = {};
    const previous = existsSync(join(MODEL_PATH, "download.json"))
      ? await json<{ revision: string; hashes: Record<string, string> }>(join(MODEL_PATH, "download.json")) : undefined;
    for (const file of FILES) {
      const path = join(MODEL_PATH, file);
      const expected = file.endsWith(".onnx") ? WEIGHT_HASH : previous?.revision === REVISION ? previous.hashes[file] : undefined;
      if (existsSync(path) && expected && await fileHash(path) === expected) { hashes[file] = expected; continue; }
      console.error(`下载 MiniLM：${file}`);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.download`;
      const handle = await open(temp, "w");
      const hash = createHash("sha256"); let size = 0;
      try {
        const response = await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`, { signal: AbortSignal.timeout(600000) });
        if (!response.ok || !response.body) throw new RagError("MODEL_DOWNLOAD_FAILED", `${file}: HTTP ${response.status}`);
        for await (const block of response.body) {
          size += block.byteLength;
          if (size > (file.endsWith(".onnx") ? 130_000_000 : 30_000_000)) throw new RagError("MODEL_TOO_LARGE", file);
          hash.update(block); await handle.writeFile(block);
        }
        const actual = hash.digest("hex");
        if (!size || (file.endsWith(".onnx") && actual !== WEIGHT_HASH)) throw new RagError("MODEL_HASH_MISMATCH", file);
        if (!file.endsWith(".onnx")) JSON.parse(await readFile(temp, "utf8"));
        await handle.close(); await rename(temp, path); hashes[file] = actual;
      } finally { await handle.close().catch(() => {}); await rm(temp, { force: true }); }
    }
    await atomicJson(join(MODEL_PATH, "download.json"), { model: MODEL, revision: REVISION, hashes });
    console.log(`模型已保存：${MODEL_PATH}。后续 index/search 禁止联网下载。`);
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export type ModelInfo = { name: string; path: string; fingerprint: string; runtime: string; dimensions: number; max_tokens: number; device: string; dtype: string };
export class MiniLM {
  private constructor(private readonly extractor: FeatureExtractionPipeline, public readonly info: ModelInfo) {}
  static async load(): Promise<MiniLM> {
    const receiptPath = join(MODEL_PATH, "download.json");
    if (!existsSync(receiptPath)) throw new RagError("MODEL_NOT_FOUND", "先运行 pnpm rag:setup 下载 TS 使用的 ONNX 模型；PyTorch 权重不能直接加载。");
    const receipt = await json<{ model: string; revision: string; hashes: Record<string, string> }>(receiptPath);
    if (receipt.model !== MODEL || receipt.revision !== REVISION) throw new RagError("MODEL_CHANGED", "模型版本不同，请重新执行 rag:setup。");
    for (const file of FILES) if (!existsSync(join(MODEL_PATH, file)) || await fileHash(join(MODEL_PATH, file)) !== receipt.hashes[file]) {
      throw new RagError("MODEL_HASH_MISMATCH", `${file} 缺失或发生变化，请运行 rag:setup。`);
    }
    if (receipt.hashes["onnx/model_quantized.onnx"] !== WEIGHT_HASH) throw new RagError("MODEL_HASH_MISMATCH", "ONNX 权重不是固定版本。");
    const config = await json<{ hidden_size: number; model_type: string }>(join(MODEL_PATH, "config.json"));
    if (config.hidden_size !== 384 || config.model_type !== "bert") throw new RagError("MODEL_CONFIG_MISMATCH", "预期 BERT MiniLM 384 维。");
    env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false;
    console.error("加载本地 MiniLM ONNX q8 / CPU，禁止联网下载。");
    const extractor = await pipeline("feature-extraction", MODEL_PATH, { dtype: "q8", device: "cpu", local_files_only: true,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
    const runtimePackage = await json<{ version: string }>(join(ROOT, "node_modules/@huggingface/transformers/package.json"));
    const runtime = `transformers.js-${runtimePackage.version}/node-${process.versions.node}/cpu-q8/mean-l2`;
    const info: ModelInfo = { name: MODEL, path: MODEL_PATH, runtime, fingerprint: sha256(JSON.stringify(receipt) + runtime), dimensions: 384, max_tokens: 128, device: "cpu", dtype: "q8" };
    return new MiniLM(extractor, info);
  }
  count(text: string, special = true): number { return this.extractor.tokenizer.encode(text, { add_special_tokens: special }).length; }
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.some(text => this.count(text) > 128)) throw new RagError("INPUT_TOO_LONG", "向量输入超过 128 tokens。");
    const output = await this.extractor(texts, { pooling: "mean", normalize: true });
    if (output.dims[0] !== texts.length || output.dims[1] !== 384) throw new RagError("INVALID_EMBEDDING", "模型输出维度不符。");
    const data = Float32Array.from(output.data as Float32Array);
    return texts.map((_, index) => { const vector = data.slice(index * 384, (index + 1) * 384); validateVector(vector); return vector; });
  }
  async dispose(): Promise<void> { await this.extractor.dispose(); }
}
export function validateVector(vector: Float32Array): void {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (vector.length !== 384 || vector.some(value => !Number.isFinite(value)) || Math.abs(norm - 1) > 0.01) throw new RagError("INVALID_EMBEDDING", "向量长度、数值或归一化不符。");
}
