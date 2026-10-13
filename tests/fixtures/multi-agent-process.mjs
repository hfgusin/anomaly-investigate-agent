import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../dist/session-store.js";
import { RunCoordinator } from "../../dist/run-coordinator.js";

export function crashRuntime(store, logPath) {
  return { info: { kind: "demo", label: "process-crash-fixture", model: null }, async *stream(input) {
    const question = input.messages.at(-1).content;
    if (question.startsWith("/team")) {
      if (question.includes("已保存检查点")) {
        const parent = store.history(store.list()[0].id).runs[0];
        yield store.children(parent.id).map((child) => `[child:${child.id}]`).join(" "); return;
      }
      const result = await input.callTool({ id: "dispatch", name: "delegate_task", arguments: JSON.stringify({ tasks: [
        { key: "done", agentId: "reader", input: "done" }, { key: "slow", agentId: "reader", input: "slow" },
      ] }) });
      yield JSON.parse(result.content).children.map((child) => `[child:${child.runId}]`).join(" "); return;
    }
    appendFileSync(logPath, question.startsWith("done") ? "done\n" : "slow\n");
    if (question.startsWith("done")) { yield "persisted answer"; return; }
    if (question.includes("已保存检查点")) { yield "resumed answer"; return; }
    await new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
  } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new SessionStore(process.argv[2]); let coordinator; let printed = false;
  coordinator = new RunCoordinator(store, crashRuntime(store, process.argv[3]), (run) => {
    for (const tool of JSON.parse(run.toolTrace).filter((call) => call.status === "requested")) coordinator.decideTool(run.id, tool.id, "approved");
    if (run.parentRunId) {
      const children = store.children(run.parentRunId);
      if (!printed && children.some((child) => child.status === "completed") && children.some((child) => child.status === "running")) {
        printed = true; console.log(JSON.stringify({ parentId: run.parentRunId, children: children.map((child) => child.id) }));
      }
    }
  });
  coordinator.accept(store.create().id, "kill", "/team process crash");
}
