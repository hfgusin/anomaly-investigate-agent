import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { LangChainRuntime } from '../dist/providers/langchain.js';
import { DiExportTool } from '../dist/tools/di-export.js';

const root = resolve(import.meta.dirname, '..');
const definitions = [{ type: 'function', function: { name: 'read_file', description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const message = text => ({ type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text,
  annotations: [{ type: 'url_citation', title: 'Source', url: 'https://example.org/evidence' }] }] });

async function fixture(scenario, check) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); requests.push(body);
    if (scenario === 'http') { response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture-secret' } })); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (scenario === 'slow') {
      send({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] });
      return; // Kept open until cancellation closes the request.
    }
    if (request.url === '/v1/chat/completions') {
      const chunk = (delta, finish_reason = null) => send({ id: 'fixture', object: 'chat.completion.chunk',
        created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
      if (['tool', 'di', 'sql', 'greet'].includes(scenario) && requests.length === 1) {
        const name = scenario === 'di' ? 'di_export_table' : scenario === 'sql' ? 'di_query_sql' : scenario === 'greet' ? 'greet_user' : 'read_file';
        const args = scenario === 'di' ? '{"action":"status","query_id":"0f449fb7-37ac-4c20-b0ec-8053a4a2f706"}'
          : scenario === 'sql' ? '{"action":"sql","sql":"SELECT 1 AS value"}' : (scenario === 'greet' ? '{"name":"Yara"}' : '{"path":"a.txt"}');
        chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function',
          function: { name, arguments: args } }] }); chunk({}, 'tool_calls');
      } else { chunk({ content: '你好😀' }); if (scenario !== 'truncated') chunk({}, 'stop'); }
    } else {
      if (['tool', 'di', 'sql', 'greet'].includes(scenario) && requests.length === 1) {
        send({ type: 'response.completed', response: { status: 'completed', output: [
          { id: 'fc', type: 'function_call', call_id: 'call-1',
            name: scenario === 'di' ? 'di_export_table' : scenario === 'sql' ? 'di_query_sql' : scenario === 'greet' ? 'greet_user' : 'read_file',
            arguments: scenario === 'di' ? '{"action":"status","query_id":"0f449fb7-37ac-4c20-b0ec-8053a4a2f706"}'
              : scenario === 'sql' ? '{"action":"sql","sql":"SELECT 1 AS value"}' : (scenario === 'greet' ? '{"name":"Yara"}' : '{"path":"a.txt"}') }] } });
      } else {
        const search = { id: 'web1', type: 'web_search_call', status: 'completed', action: { queries: ['fixture query'] } };
        send({ type: 'response.output_item.done', item: search });
        send({ type: 'response.output_text.delta', delta: '你好😀' });
        if (scenario !== 'truncated') send({ type: 'response.completed',
          response: { status: 'completed', output: [search, message('你好😀')] } });
      }
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  try { await check(`http://127.0.0.1:${server.address().port}/v1`, requests); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

function runtime(baseUrl, kind, config = {}) {
  return new LangChainRuntime(root, { baseUrl, model: 'fixture', apiKey: 'fixture-secret', ...config },
    { kind, label: 'fixture', model: 'fixture' }, '.venv-di/bin/python');
}
const input = () => ({ messages: [{ role: 'user', content: 'test' }], signal: new AbortController().signal });

for (const kind of ['chat-completions', 'responses']) {
  for (const scenario of ['text', 'tool', 'truncated', 'http']) {
    test(`Python LangChain ${kind}: ${scenario}`, { timeout: 30000 }, async () => {
      await fixture(scenario, async (baseUrl, requests) => {
        const model = runtime(baseUrl, kind); const chunks = []; let toolCalls = 0; let error;
        try {
          for await (const chunk of model.stream({ ...input(), toolDefinitions: definitions, callTool: async call => {
            assert.equal(model.limits().active, 0); assert.equal(call.name, 'read_file'); toolCalls++;
            return { content: '用户拒绝了这次工具调用。', isError: true, denied: true };
          } })) chunks.push(chunk);
        } catch (caught) { error = caught; }
        if (scenario === 'http') {
          assert.equal(error?.code, 'PROVIDER_HTTP_ERROR'); assert.ok(!error.message.includes('fixture-secret'));
        } else if (scenario === 'truncated') { assert.ok(error, 'truncated stream must fail'); }
        else { assert.equal(error, undefined); assert.equal(chunks.filter(c => typeof c === 'string').join(''), '你好😀'); }
        if (scenario === 'tool') {
          assert.equal(toolCalls, 1); assert.equal(requests.length, 2);
          const feedback = kind === 'responses' ? requests[1].input.find(i => i.type === 'function_call_output')
            : requests[1].messages.find(i => i.role === 'tool');
          assert.ok((feedback.output ?? feedback.content).includes('用户拒绝'));
        }
        if (kind === 'responses' && scenario === 'text') {
          assert.deepEqual(chunks.filter(c => typeof c !== 'string').map(c => c.event), ['web.search', 'web.sources']);
          assert.ok(requests[0].tools.some(tool => tool.type === 'web_search' && tool.max_keyword === 3));
          assert.equal(requests[0].store, false);
        }
        assert.equal(model.limits().active, 0);
      });
    });
  }
}

test('Python LangChain stops a live stream and releases the model slot', { timeout: 30000 }, async () => {
  await fixture('slow', async baseUrl => {
    const model = runtime(baseUrl, 'chat-completions'); const controller = new AbortController();
    const reason = new Error('user stopped'); const chunks = [];
    await assert.rejects(async () => {
      for await (const chunk of model.stream({ ...input(), signal: controller.signal })) {
        chunks.push(chunk); controller.abort(reason);
      }
    }, error => error === reason);
    assert.deepEqual(chunks, ['partial']); assert.equal(model.limits().active, 0);
  });
});

test('Python LangChain plain mode rejects tools without a second request', { timeout: 30000 }, async () => {
  await fixture('tool', async (baseUrl, requests) => {
    const model = runtime(baseUrl, 'chat-completions', { toolResultMode: 'plain' }); const chunks = [];
    for await (const chunk of model.stream({ ...input(), toolDefinitions: definitions,
      callTool: async () => ({ content: '拒绝', isError: true, denied: true }) })) chunks.push(chunk);
    assert.equal(requests.length, 1); assert.match(chunks.join(''), /工具没有执行/);
  });
});

test('Python LangChain plain mode feeds an approved tool result back as text', { timeout: 30000 }, async () => {
  await fixture('tool', async (baseUrl, requests) => {
    const model = runtime(baseUrl, 'chat-completions', { toolResultMode: 'plain' }); const chunks = [];
    for await (const chunk of model.stream({ ...input(), toolDefinitions: definitions,
      callTool: async () => ({ content: 'Cedar-731', isError: false }) })) chunks.push(chunk);
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].messages), /Cedar-731/);
    assert.equal(requests[1].tools, undefined);
    assert.equal(chunks.filter(c => typeof c === 'string').join(''), '你好😀');
  });
});

for (const kind of ['chat-completions', 'responses']) {
  test(`Python LangChain ${kind} binds the Python DI StructuredTool schema`, { timeout: 30000 }, async () => {
    await fixture('di', async (baseUrl, requests) => {
      const model = runtime(baseUrl, kind); const di = new DiExportTool(root); let calls = 0;
      for await (const _chunk of model.stream({ ...input(),
        toolDefinitions: [...definitions, di.definition, di.sqlDefinition], activeToolNames: ['di_export_table'],
        callTool: async call => {
          assert.equal(call.name, 'di_export_table');
          assert.equal(JSON.parse(call.arguments).action, 'status');
          assert.equal(model.limits().active, 0); calls++;
          return { content: '拒绝：测试只检查 schema', isError: true, denied: true };
        } })) { /* Model result deliberately synthetic; tests binding and RPC only. */ }
      const bound = requests[0].tools.find(t => (t.function?.name ?? t.name) === 'di_export_table');
      const schema = bound.function ?? bound;
      assert.match(schema.description, /优先复用已有会话/); // Python description, not TS placeholder.
      assert.ok(schema.parameters.properties.query_id);
      assert.deepEqual(requests[0].tools.map(t => t.function?.name ?? t.name), ['di_export_table']);
      assert.equal(calls, 1); assert.equal(requests.length, 2);
    });
  });

  test(`Python LangChain ${kind} binds the raw SQL StructuredTool schema`, { timeout: 30000 }, async () => {
    await fixture('sql', async (baseUrl, requests) => {
      const model = runtime(baseUrl, kind); const di = new DiExportTool(root); let calls = 0;
      for await (const _chunk of model.stream({ ...input(),
        toolDefinitions: [...definitions, di.definition, di.sqlDefinition], activeToolNames: ['di_query_sql'],
        callTool: async call => {
          assert.equal(call.name, 'di_query_sql');
          assert.equal(JSON.parse(call.arguments).sql, 'SELECT 1 AS value'); calls++;
          return { content: '拒绝：测试只检查 schema', isError: true, denied: true };
        } })) { /* Tool result is synthetic; this checks Agent + ToolNode binding and RPC. */ }
      const bound = requests[0].tools.find(t => (t.function?.name ?? t.name) === 'di_query_sql');
      const schema = bound.function ?? bound;
      assert.match(schema.description, /只读 Spark SQL/);
      assert.equal(schema.parameters.properties.sql.anyOf[0].maxLength, 7000); // Python Pydantic schema is authoritative.
      assert.deepEqual(requests[0].tools.map(t => t.function?.name ?? t.name), ['di_query_sql']);
      assert.equal(calls, 1); assert.equal(requests.length, 2);
    });
  });
}

for (const kind of ['chat-completions', 'responses']) {
  for (const approved of [true, false]) {
    test(`Python @tool actually executes after approval: ${kind} ${approved}`, { timeout: 30000 }, async () => {
      await fixture('greet', async (baseUrl, requests) => {
        let calls = 0;
        for await (const _ of runtime(baseUrl, kind).stream({ ...input(),
          toolDefinitions: [{ type: 'function', function: { name: 'greet_user' } }],
          callTool: async (call, executePython) => {
            calls++;
            assert.equal(call.name, 'greet_user');
            assert.equal(typeof executePython, 'function');
            if (!approved) return { content: '用户拒绝', denied: true, isError: true };
            const result = await executePython(call.arguments);
            assert.equal(result.isError, false);
            assert.match(result.content, /你好，Yara！.*Python/);
            return result;
          },
        })) { /* Actual local Python function, no external business service. */ }
        assert.equal(calls, 1);
        assert.equal(requests.length, 2);
        const feedback = JSON.stringify(requests[1]);
        assert.match(feedback, approved ? /你好，Yara/ : /用户拒绝/);
        if (!approved) assert.doesNotMatch(feedback, /这条结果来自 Python/);
      });
    });
  }
}
