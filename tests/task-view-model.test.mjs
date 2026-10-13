import test from "node:test";
import assert from "node:assert/strict";
import { taskView } from "../public/task-view-model.js";

test("task detail shows only completed tool evidence and durable recovery attempts", () => {
  const run = {
    output: "根据 [Film#1, Author#0] 回答。", checkpoint: JSON.stringify({ seq: 9, phase: "completed" }),
    toolTrace: JSON.stringify([
      { id: "s1", name: "search_passages", status: "completed", result: JSON.stringify({ status: "ok", candidates: [{ title: "Film" }] }) },
      { id: "o1", name: "open_passage", status: "completed", result: JSON.stringify({ status: "ok", title: "Film", sentences: [{ citation: "Film#1", text: "Film fact" }] }) },
      { id: "o2", name: "open_passage", status: "completed", result: JSON.stringify({ status: "ok", title: "Author", sentences: [{ citation: "Author#0", text: "Author fact" }] }) },
      { id: "o3", name: "open_passage", status: "requested", result: null },
      { id: "o4", name: "open_passage", status: "failed", result: JSON.stringify({ status: "ok", title: "Wrong", sentences: [{ citation: "Wrong#0", text: "not evidence" }] }) },
    ]),
  };
  const events = [{ seq: 1, type: "run.accepted", payload: "{}", createdAt: "today" }];
  const attempts = [{ attempt: 1, partialOutput: "draft", interruptedAt: "yesterday" }];
  const view = taskView(run, events, attempts);
  assert.deepEqual(view.sources.map((item) => [item.title, item.cited]), [["Film", 1], ["Author", 1]]);
  assert.equal(view.pendingApprovals[0].id, "o3");
  assert.equal(view.events[0].type, "run.accepted");
  assert.equal(view.attempts[0].partialOutput, "draft");
});
