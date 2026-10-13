import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ResearchWorkerClient } from "../dist/tools/research-worker-client.js";

const path = "data/hotpotqa/validation-sample.json";
const question = JSON.parse(readFileSync(path, "utf8"))[0].question;
const args = { question };
const signal = new AbortController().signal;

test("fault injection: a hung research tool times out, then a fresh Worker succeeds", { timeout: 5000 }, async () => {
  const client = new ResearchWorkerClient(path, 250);
  try {
    await assert.rejects(client.execute(args, signal, "hang"), { code: "TOOL_TIMEOUT" });
    const result = JSON.parse(await client.execute(args, signal));
    assert.equal(result.status, "ok");
  } finally { await client.close(); }
});

test("fault injection: duplicate Worker result is accepted once", { timeout: 5000 }, async () => {
  const client = new ResearchWorkerClient(path);
  try {
    const result = JSON.parse(await client.execute(args, signal, "duplicate"));
    assert.equal(result.corpusId, "5a8c7595554299585d9e36b6");
    assert.equal(JSON.parse(await client.execute(args, signal)).status, "ok");
  } finally { await client.close(); }
});

test("fault injection: Worker crash fails in-flight work and next call restarts it", { timeout: 5000 }, async () => {
  const client = new ResearchWorkerClient(path);
  try {
    await assert.rejects(client.execute(args, signal, "crash"), { code: "WORKER_EXITED" });
    assert.equal(JSON.parse(await client.execute(args, signal)).status, "ok");
  } finally { await client.close(); }
});
