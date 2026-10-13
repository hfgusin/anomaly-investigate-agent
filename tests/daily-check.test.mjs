import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { LangChainRuntime } from '../dist/providers/langchain.js';
import { RunCoordinator } from '../dist/run-coordinator.js';
import { SessionStore } from '../dist/session-store.js';
import { ToolRegistry } from '../dist/tools/read-file.js';
import { readPythonToolCatalog } from '../dist/python-tool-catalog.js';

const root = resolve(import.meta.dirname, '..');
{
  test('Daily check: read-only Airflow tool is auto-approved through the real TS bridge and Python ToolNode', { timeout: 30000 }, async () => {
    let apiCalls = 0;
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        apiCalls++;
        assert.equal(request.url, '/api/v1/dags/a/dagRuns/r/taskInstances/t');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ task_id: 't', state: 'failed', try_number: 1 }));
        return;
      }
      const parts = []; for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (!body.messages.some(m => m.role === 'tool')) {
        send({ content: '先查询任务状态，核对日志尝试编号。' });
        send({ tool_calls: [{ index: 0, id: 'call-airflow', type: 'function', function: { name: 'airflow_get_task',
          arguments: '{"dag_id":"a","dag_run_id":"r","task_id":"t"}' } }] });
        send({}, 'tool_calls');
      } else {
        const result = body.messages.find(m => m.role === 'tool');
        assert.equal(JSON.parse(result.content).task.state, 'failed');
        send({ content: '已检查，业务失败状态与工具查询成功是两回事。' }); send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const oldUrl = process.env.AIRFLOW_BASE_URL, oldToken = process.env.AIRFLOW_TOKEN;
    process.env.AIRFLOW_BASE_URL = baseUrl; process.env.AIRFLOW_TOKEN = 'fixture';
    const store = new SessionStore(':memory:');
    const tools = new ToolRegistry(resolve(root, 'workspace'));
    tools.setPythonTools(readPythonToolCatalog(root, { AGENT_PYTHON: '.venv-di/bin/python' }));
    const runtime = new LangChainRuntime(root, { baseUrl: baseUrl + '/v1', model: 'fixture', apiKey: 'fixture' },
      { kind: 'chat-completions', label: 'fixture', model: 'fixture' }, '.venv-di/bin/python');
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const coordinator = new RunCoordinator(store, runtime, run => {
      if (['completed', 'failed'].includes(run.status)) finish(run);
    }, 15000, tools);
    try {
      coordinator.accept(store.create().id, 'daily-auto', '查任务状态');
      const run = await finished;
      assert.equal(run.status, 'completed', run.error);
      assert.equal(apiCalls, 1);
      const call = JSON.parse(run.toolTrace)[0];
      assert.equal(call.status, 'completed');
      assert.equal(call.label, '查询 Airflow（只读，日志可保存本地）');
      assert.equal(JSON.parse(call.result).task.state, 'failed');
      const action = JSON.parse(run.providerTrace).find(e => e.event === 'agent.action');
      assert.equal(action.payload.text, '先查询任务状态，核对日志尝试编号。');
    } finally {
      await coordinator.shutdown(); store.close(); await tools.close();
      if (oldUrl === undefined) delete process.env.AIRFLOW_BASE_URL; else process.env.AIRFLOW_BASE_URL = oldUrl;
      if (oldToken === undefined) delete process.env.AIRFLOW_TOKEN; else process.env.AIRFLOW_TOKEN = oldToken;
      server.closeAllConnections(); await new Promise(done => server.close(done));
    }
  });
}
