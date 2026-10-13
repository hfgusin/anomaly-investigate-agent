import { parentPort, workerData } from "node:worker_threads";
import { ResearchHotpotTool } from "./research-hotpot.js";

if (!parentPort) throw new Error("research-worker must run as a Worker");
const tool = new ResearchHotpotTool(workerData.datasetPath as string);
parentPort.on("message", (message: { id: number; args: unknown; fault?: string; operation?: string }) => {
  if (message.fault === "hang") return;
  if (message.fault === "crash") process.exit(17);
  try {
    let content: string;
    if (message.operation === "search_passages") {
      const args = message.args as { question: string; query: string };
      content = tool.search(args.question, args.query, new AbortController().signal);
    } else if (message.operation === "open_passage") {
      const args = message.args as { question: string; title: string };
      content = tool.open(args.question, args.title, new AbortController().signal);
    } else if (!message.operation || message.operation === "research_hotpot") {
      content = tool.execute(message.args, new AbortController().signal);
    } else throw new Error("未知研究操作。");
    parentPort!.postMessage({ id: message.id, content });
    if (message.fault === "duplicate") parentPort!.postMessage({ id: message.id, content });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "研究工具失败。" });
  }
});
