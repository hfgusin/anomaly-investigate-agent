import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { EventEmitter } from "node:events";
import { readConfig } from "../dist/config.js";
import { RunCoordinator } from "../dist/run-coordinator.js";
import { SessionStore, isPending } from "../dist/session-store.js";

const root = resolve(import.meta.dirname, "..");
if (existsSync(join(root, ".env"))) loadEnvFile(join(root, ".env"));
const { runtime } = readConfig(process.env, root);
if (runtime.info.kind !== "chat-completions") throw new Error("需要在 .env 中启用真实 Chat Completions 模型。");

const directory = mkdtempSync(join(tmpdir(), "mirror-memory-live-"));
const store = new SessionStore(join(directory, "memory.sqlite"));
const bus = new EventEmitter();
const coordinator = new RunCoordinator(store, runtime, (run) => bus.emit("run", run), 120_000, undefined, 4096);
try {
  const session = store.create();
  const marker = `Amber-${randomUUID().slice(0, 8)}`;
  const fact = store.accept(session.id, "fact", `我的项目代号是 ${marker}。`);
  store.start(fact.id); store.appendOutput(fact.id, `已记录：${marker}。`); store.finish(fact.id, "completed");
  const filler = store.accept(session.id, "filler", "以下是与项目代号无关的填充对话。");
  store.start(filler.id); store.appendOutput(filler.id, "填充文本。".repeat(1200)); store.finish(filler.id, "completed");
  const run = coordinator.accept(session.id, "question", "只根据之前的对话回答：我的项目代号是什么？只输出代号。");
  const result = await new Promise((resolve) => {
    const current = store.getRun(run.id);
    if (!isPending(current)) { resolve(current); return; }
    const listener = (next) => {
      if (next.id === run.id && !isPending(next)) { bus.off("run", listener); resolve(next); }
    };
    bus.on("run", listener);
  });
  const trace = JSON.parse(result.contextTrace);
  const snapshot = trace.memorySnapshotId ? store.memorySnapshot(trace.memorySnapshotId) : undefined;
  const context = store.contextFor(run.id, 4096);
  const checks = {
    completed: result.status === "completed",
    summaryCompleted: trace.memoryStatus === "completed",
    summaryVersioned: trace.memoryVersion === 1,
    sourceLinked: Boolean(snapshot && JSON.parse(snapshot.sourceRunIds).includes(fact.id)),
    summaryContainsFact: snapshot?.summaryContent?.includes(marker) ?? false,
    summaryCitesFactRun: snapshot?.summaryContent?.includes(fact.id) ?? false,
    withinBudget: trace.usedChars <= trace.budgetChars,
    totalBudgetAccounted: trace.usedChars + trace.systemAndToolDefinitionChars + trace.outputReserveChars +
      trace.toolResultReserveChars <= trace.totalBudgetChars,
    answeredFact: result.output.trim() === marker,
  };
  process.stdout.write(`${JSON.stringify({ checks, memoryMessage: context.messages[0]?.content,
    summaryError: snapshot?.summaryError, answer: result.output, trace, error: result.error }, null, 2)}\n`);
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
} finally {
  await coordinator.shutdown();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
