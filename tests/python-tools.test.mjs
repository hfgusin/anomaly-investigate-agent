import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readPythonToolCatalog } from '../dist/python-tool-catalog.js';
import { ToolRegistry } from '../dist/tools/read-file.js';
import { SessionStore } from '../dist/session-store.js';
import { RunCoordinator } from '../dist/run-coordinator.js';
import { isAutoApproved, toolLabel } from '../dist/tool-policy.js';

const root = resolve(import.meta.dirname, '..');
test('Python catalog supplies schema, policy and Skill filtering without a TS business definition', () => {
  const entries = readPythonToolCatalog(root, { AGENT_PYTHON: '.venv-di/bin/python' });
  const tools = new ToolRegistry(resolve(root, 'workspace'));
  tools.setPythonTools(entries);
  assert.equal(tools.policyError('greet_user'), undefined);
  assert.equal(tools.definitions.filter(d => d.function.name === 'di_query_sql').length, 1);
  const greet = tools.definitions.find(d => d.function.name === 'greet_user');
  assert.ok(greet.function.parameters.properties.name);
  assert.deepEqual(tools.definitionsFor('growth').map(d => d.function.name), ['di_export_table', 'di_query_sql']);
  const daily = tools.definitionsFor('daily-check').map(d => d.function.name);
  for (const name of ['airflow_scan_failures', 'dataservice_api_detail', 'read_project_source', 'read_gsheet_rows', 'record_automation_check', 'di_query_sql']) assert.ok(daily.includes(name));
  assert.ok(!daily.includes('di_export_table'));
  assert.ok(isAutoApproved('airflow_get_task_log'));
  assert.ok(!isAutoApproved('record_automation_check'));
  assert.ok(!isAutoApproved('di_query_sql'));
  assert.equal(toolLabel('read_project_source'), '读取映射的本地源码（不执行）');
  assert.ok(!daily.includes('write_file'));
  assert.ok(!daily.includes('run_javascript'));
  assert.ok(daily.includes('search_business_sources'));
  assert.deepEqual(tools.definitionsFor('source-lookup').map(d => d.function.name).sort(),
    ['di_query_sql', 'read_project_source', 'search_business_sources']);
  assert.ok(isAutoApproved('search_business_sources'));
});

for (const decision of ['approved', 'rejected']) {
  test(`Gateway ${decision} Python tools and records actual execution without TS dispatch`, async () => {
    const store = new SessionStore(':memory:');
    let executed = 0;
    let dispatched = 0;
    const tools = { definitions: [{ type: 'function', function: { name: 'greet_user' } }],
      policyError: () => undefined,
      execute: async () => { dispatched++; throw Error('must not dispatch'); } };
    const runtime = { info: { kind: 'demo', label: 'fixture', model: null }, async *stream({ callTool }) {
      const result = await callTool({ id: 'hello', name: 'greet_user', arguments: '{"name":"Yara"}' }, async args => {
        assert.equal(JSON.parse(args).name, 'Yara'); executed++;
        return { content: 'actual Python result', isError: false };
      });
      yield result.content;
    } };
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const coordinator = new RunCoordinator(store, runtime, run => {
      const trace = JSON.parse(run.toolTrace);
      if (trace.some(c => c.status === 'requested')) queueMicrotask(() => coordinator.decideTool(run.id, 'hello', decision));
      if (run.status === 'completed' || run.status === 'failed') finish(run);
    }, 3000, tools);
    try {
      const session = store.create();
      coordinator.accept(session.id, `python-${decision}`, 'say hello');
      const run = await finished;
      assert.equal(run.status, 'completed', run.error ?? JSON.stringify(run));
      const trace = JSON.parse(run.toolTrace);
      assert.equal(trace[0].status, decision === 'approved' ? 'completed' : 'rejected');
      assert.equal(executed, decision === 'approved' ? 1 : 0);
      assert.equal(dispatched, 0);
      if (decision === 'approved') assert.equal(trace[0].result, 'actual Python result');
    } finally { await coordinator.shutdown(); store.close(); }
  });
}

test('16 queries leave recording allowance; overflow keeps parameters and recording still needs approval', async () => {
  const { registerPythonTool } = await import('../dist/tool-policy.js');
  registerPythonTool('quota_read', { risk: 'read', label: 'read', autoApprove: true, budgetGroup: 'query' });
  registerPythonTool('quota_record', { risk: 'write', label: 'record', autoApprove: false, budgetGroup: 'record' });
  const store = new SessionStore(':memory:');
  const executed = [];
  const tools = { definitions: ['quota_read', 'quota_record'].map(name => ({ type: 'function', function: { name } })),
    policyError: () => undefined, execute: async name => { executed.push(name); return { content: 'ok', isError: false }; } };
  const runtime = { info: { kind: 'demo', label: 'fixture', model: null }, async *stream({ callTool }) {
    for (let i = 0; i < 16; i++) assert.equal((await callTool({ id: `q${i}`, name: 'quota_read', arguments: '{}' })).isError, false);
    assert.equal((await callTool({ id: 'overflow', name: 'quota_read', arguments: '{"purpose":"extra"}' })).isError, true);
    for (let i = 0; i < 2; i++) assert.equal((await callTool({ id: `r${i}`, name: 'quota_record', arguments: '{}' })).isError, false);
    assert.equal((await callTool({ id: 'record-overflow', name: 'quota_record', arguments: '{}' })).isError, true);
    yield '报告已完成';
  } };
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const approved = new Set();
  const coordinator = new RunCoordinator(store, runtime, run => {
    for (const call of JSON.parse(run.toolTrace).filter(c => c.status === 'requested' && c.name === 'quota_record')) {
      if (!approved.has(call.id)) { approved.add(call.id); queueMicrotask(() => coordinator.decideTool(run.id, call.id, 'approved')); }
    }
    if (['completed', 'failed'].includes(run.status)) finish(run);
  }, 3000, tools);
  try {
    coordinator.accept(store.create().id, 'quota', 'check');
    const run = await finished;
    assert.equal(run.status, 'completed', run.error);
    assert.equal(executed.length, 18);
    assert.equal(approved.size, 2);
    const blocked = JSON.parse(run.providerTrace).filter(e => e.event === 'tool.limit_reached');
    assert.equal(blocked.length, 2);
    assert.equal(blocked[0].payload.arguments, '{"purpose":"extra"}');
    assert.equal(blocked[0].payload.used, 16);
  } finally { await coordinator.shutdown(); store.close(); }
});
