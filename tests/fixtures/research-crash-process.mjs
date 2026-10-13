import { readFileSync } from "node:fs";
import { SessionStore } from "../../dist/session-store.js";
import { ResearchWorkerClient } from "../../dist/tools/research-worker-client.js";

const [path, stage] = process.argv.slice(2);
if (!["started", "returned", "committed"].includes(stage)) throw new Error("Unknown crash stage");
const data = "data/hotpotqa/validation-sample.json";
const record = JSON.parse(readFileSync(data, "utf8"))[0];
const store = new SessionStore(path);
const run = store.accept(store.create().id, `crash-${stage}`, `/research2 ${record.question}`);
store.start(run.id);
store.requestTool(run.id, "s1", "search_passages", JSON.stringify({ query: record.question }));
store.decideTool(run.id, "s1", "approved");
store.startTool(run.id, "s1");
let result = null;
if (stage !== "started") {
  const worker = new ResearchWorkerClient(data);
  result = await worker.execute({ question: record.question, query: record.question },
    new AbortController().signal, undefined, "search_passages");
  await worker.close();
}
if (stage === "committed") store.finishTool(run.id, "s1", result, false);
process.stdout.write(JSON.stringify({ runId: run.id, stage, result }) + "\n");
setInterval(() => undefined, 1000);
