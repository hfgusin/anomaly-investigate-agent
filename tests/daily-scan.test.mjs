import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyScan } from '../dist/daily-scan.js';

function fixture(runner) {
  const root = mkdtempSync(join(tmpdir(), 'daily-scan-'));
  let now = new Date('2026-10-12T00:30:00Z');  // 北京时间 08:30
  const scan = new DailyScan(root, runner, () => now);
  return { scan, root, at: value => { now = new Date(value); } };
}

test('daily scan runs once after 9:00 Shanghai with D-5..D0 and saves latest', async () => {
  const calls = [];
  const { scan, root, at } = fixture(async args => { calls.push(args); return { owner: 'yara', owned_dags: ['a'], failed_tasks: [] }; });
  try {
    assert.equal(await scan.due(9), false);
    at('2026-10-12T01:05:00Z');
    assert.equal(await scan.due(9), true);
    const [first, second] = await Promise.all([scan.scan(), scan.scan()]);
    assert.equal(first, second);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { start_date: '2026-10-07', end_date: '2026-10-12', owner: 'yara', time_zone: 'Asia/Shanghai' });
    assert.equal((await scan.latest()).status, 'completed');
    assert.equal(await scan.due(9), false);
    at('2026-10-13T01:05:00Z');
    assert.equal(await scan.due(9), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed daily scan is saved and retried after 30 minutes', async () => {
  const { scan, root, at } = fixture(async () => { throw new Error('Airflow 认证失败（HTTP 401）'); });
  try {
    at('2026-10-12T01:05:00Z');
    const failed = await scan.scan();
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /401/);
    at('2026-10-12T01:20:00Z');
    assert.equal(await scan.due(9), false);
    at('2026-10-12T01:40:00Z');
    assert.equal(await scan.due(9), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
