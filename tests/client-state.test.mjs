import test from "node:test";
import assert from "node:assert/strict";
import { mergeRun, visibleRuns } from "../public/client-state.js";

test("late history responses cannot overwrite newer streamed output", () => {
  const runs = new Map();
  mergeRun(runs, { id: "r", version: 4, output: "newer" });
  mergeRun(runs, { id: "r", version: 2, output: "older" });
  assert.equal(runs.get("r").output, "newer");
});
test("switching sessions and resetting excludes unrelated or old output", () => {
  const runs = new Map();
  for (const row of [
    { id: "a-old", sessionId: "a", generation: 0, position: 1 },
    { id: "a-new", sessionId: "a", generation: 1, position: 2 },
    { id: "b", sessionId: "b", generation: 0, position: 3 },
  ]) mergeRun(runs, { ...row, version: 1 });
  assert.deepEqual(visibleRuns(runs, { id: "a", generation: 1 }).map((r) => r.id), ["a-new"]);
  assert.deepEqual(visibleRuns(runs, { id: "b", generation: 0 }).map((r) => r.id), ["b"]);
});
