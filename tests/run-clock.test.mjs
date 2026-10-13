import test from 'node:test';
import assert from 'node:assert/strict';
import { RunClock } from '../dist/run-clock.js';
test('execution clock excludes approval waits but preserves cumulative work', () => {
  const clock = new RunClock(100, 1000, 2000, 0);
  assert.equal(clock.tick(false, 40), undefined);
  assert.equal(clock.tick(true, 45), undefined);
  assert.equal(clock.tick(true, 500), undefined);
  assert.equal(clock.tick(false, 510), undefined);
  assert.equal(clock.tick(false, 575).code, 'TIMEOUT');
});
test('approval timeout and total deadline have distinct failure codes', () => {
  const approval = new RunClock(100, 200, 1000, 0);
  approval.tick(true, 10);
  assert.equal(approval.tick(true, 211).code, 'APPROVAL_TIMEOUT');
  const total = new RunClock(100, 2000, 500, 0);
  total.tick(true, 10);
  assert.equal(total.tick(true, 501).code, 'RUN_DEADLINE');
});

test('actual Coordinator allows an approval wait longer than execution budget', { timeout: 4000 }, async () => {
  const { SessionStore } = await import('../dist/session-store.js');
  const { RunCoordinator } = await import('../dist/run-coordinator.js');
  const store = new SessionStore(':memory:');
  let requested;
  const pending = new Promise(resolve => { requested = resolve; });
  const tools = { definitions: [], async execute() { return { content: 'ok', isError: false }; } };
  const runtime = { info: { kind: 'demo', label: 'approval fixture' }, async *stream(input) {
    await input.callTool({ id: 'read', name: 'read_file', arguments: '{}' }); yield 'done';
  } };
  const coordinator = new RunCoordinator(store, runtime, run => {
    if (JSON.parse(run.toolTrace).some(c => c.status === 'requested')) requested();
  }, 150, tools);
  try {
    const run = coordinator.accept(store.create().id, 'wait', 'read');
    await pending;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(store.getRun(run.id).status, 'running');
    coordinator.decideTool(run.id, 'read', 'approved');
    for (let i = 0; i < 100 && store.getRun(run.id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.getRun(run.id).status, 'completed');
  } finally { await coordinator.shutdown(); store.close(); }
});
