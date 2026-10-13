import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../dist/session-store.js';
import { redactTrace } from '../dist/trace-redaction.js';

test('failed SQL call retains arguments, timeout cause and ordered events in a private JSON file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-trace-'));
  const store = new SessionStore(join(dir, 'gateway.sqlite'));
  try {
    const run = store.accept(store.create().id, 'trace-test', 'check SQL');
    store.start(run.id);
    store.requestTool(run.id, 'sql-1', 'di_query_sql', JSON.stringify({ sql: 'select 1', action: 'sql' }));
    store.decideTool(run.id, 'sql-1', 'approved');
    store.startTool(run.id, 'sql-1');
    store.finish(run.id, 'failed', '执行超时', 'TIMEOUT');
    const path = join(dir, 'run-traces', `${run.id}.json`);
    const trace = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(trace.run.status, 'failed');
    assert.deepEqual(JSON.parse(trace.tools[0].arguments), { sql: 'select 1', action: 'sql' });
    assert.match(trace.tools[0].result, /远端 SQL 状态未确认/);
    assert.equal(trace.events.at(-1).payload.errorCode, 'TIMEOUT');
    assert.ok(trace.tools[0].endedAt);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Gateway restart archives interrupted work without losing the requested SQL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-trace-'));
  const store = new SessionStore(join(dir, 'gateway.sqlite'));
  try {
    const run = store.accept(store.create().id, 'restart-test', 'check SQL');
    store.start(run.id);
    store.requestTool(run.id, 'sql-1', 'di_query_sql', '{"sql":"select 1"}');
    assert.equal(store.recoverInterrupted(), 1);
    const trace = JSON.parse(readFileSync(join(dir, 'run-traces', `${run.id}.json`), 'utf8'));
    assert.equal(trace.run.status, 'interrupted');
    assert.equal(trace.tools[0].status, 'interrupted');
    assert.equal(trace.events.at(-1).type, 'run.interrupted');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('trace export redacts nested credentials and configured secrets but preserves SQL', () => {
  process.env.TRACE_TEST_API_KEY = 'trace-only-secret';
  try {
    const trace = redactTrace({ result: '{"password":"hidden","sql":"select 1"}',
      message: 'Bearer test-token trace-only-secret', arguments: { access_token: 'hidden' } });
    assert.equal(JSON.parse(trace.result).sql, 'select 1');
    assert.equal(JSON.parse(trace.result).password, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(trace), /hidden|test-token|trace-only-secret/);
  } finally { delete process.env.TRACE_TEST_API_KEY; }
});
