import { Worker } from "node:worker_threads";
import { AppError } from "../session-store.js";

type Pending = { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  signal: AbortSignal; onAbort: () => void };

/** A crashed or timed-out worker fails its in-flight request; the next request starts a fresh worker. */
export class ResearchWorkerClient {
  private worker: Worker | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly datasetPath: string, private readonly timeoutMs = 10_000) {}

  async execute(args: unknown, signal: AbortSignal, fault?: "hang" | "crash" | "duplicate",
    operation: "research_hotpot" | "search_passages" | "open_passage" = "research_hotpot"): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new AppError("WORKER_CLOSED", "研究 Worker 已关闭。");
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return await new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.rejectPending(id, signal.reason instanceof Error ? signal.reason : new AppError("CANCELLED", "已停止。"));
      };
      const timer = setTimeout(() => {
        this.failWorker(worker, new AppError("TOOL_TIMEOUT", "研究工具超过运行时限，Worker 已重启。"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ id, args, operation, ...(fault ? { fault } : {}) });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.worker) this.failWorker(this.worker, new AppError("WORKER_CLOSED", "研究 Worker 已关闭。"));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./research-worker.js", import.meta.url),
      { workerData: { datasetPath: this.datasetPath } });
    worker.unref();
    worker.on("message", (message: { id: number; content?: string; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return; // Duplicate or stale worker event.
      this.clearPending(message.id);
      if (message.error) pending.reject(new AppError("TOOL_ERROR", message.error));
      else if (typeof message.content === "string") pending.resolve(message.content);
      else pending.reject(new AppError("WORKER_PROTOCOL", "研究 Worker 返回了无效结果。"));
    });
    worker.on("error", (error) => this.failWorker(worker, new AppError("WORKER_FAILED", error.message)));
    worker.on("exit", (code) => this.failWorker(worker,
      new AppError("WORKER_EXITED", `研究 Worker 异常退出（${code}）。`)));
    this.worker = worker;
    return worker;
  }

  private clearPending(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.onAbort);
    return pending;
  }

  private rejectPending(id: number, error: Error): void {
    this.clearPending(id)?.reject(error);
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const id of this.pending.keys()) this.rejectPending(id, error);
    void worker.terminate();
  }
}
