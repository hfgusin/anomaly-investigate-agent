import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesRuntime } from '../dist/providers/responses.js';
import { SessionStore } from '../dist/session-store.js';
import { RunCoordinator } from '../dist/run-coordinator.js';
const config = { baseUrl: 'https://ark.example/api/v3', model: 'selected', apiKey: 'test-secret' };
const source = { type: 'url_citation', title: 'Source', url: 'https://example.org/book' };
const search = { id: 'ws1', type: 'web_search_call', status: 'completed', action: { queries: ['book author'] } };
const message = text => ({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [source] }] });
const completed = output => ({ status: 'completed', output });
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(c) { for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const input = () => ({ messages: [{ role: 'user', content: '一本书' }], signal: new AbortController().signal });
async function collect(runtime, more = {}) { const chunks=[]; for await(const c of runtime.stream({...input(),...more}))chunks.push(c);return chunks; }

test('Responses streams split UTF-8, native search and citation without a local tool execution', async () => {
  let sent;
  const runtime = new ResponsesRuntime(config, async (url, init) => {
    sent = {url:String(url), body:JSON.parse(init.body)};
    return sse([{type:'response.output_item.done',item:search},{type:'response.output_text.delta',delta:'你好'},
      {type:'response.completed',response:completed([search,message('你好')])}]);
  });
  const chunks=await collect(runtime);
  assert.equal(sent.url,'https://ark.example/api/v3/responses');
  assert.equal(sent.body.stream,true);assert.equal(sent.body.store,false);
  assert.deepEqual(sent.body.tools,[{type:'web_search',max_keyword:3}]);
  assert.equal(chunks.filter(c=>typeof c==='string').join(''),'你好');
  assert.equal(chunks.filter(c=>c.event==='web.search').length,1);
  assert.equal(chunks.find(c=>c.event==='web.sources').payload.sources[0].url,source.url);
});

test('Responses releases HTTP slot before local approval and sends function_call_output in the next round', async () => {
  const requests=[];
  const runtime = new ResponsesRuntime({...config,limits:{perMinute:100,burst:10,maxConcurrent:1}},async(_,init)=>{
    const body=JSON.parse(init.body);requests.push(body);
    const output=requests.length===1?[{id:'fc1',type:'function_call',call_id:'call1',name:'read_file',arguments:'{"path":"a.txt"}'}]:[message('done')];
    return sse([{type:'response.completed',response:completed(output)}]);
  });
  const result=await collect(runtime,{toolDefinitions:[{type:'function',function:{name:'read_file',parameters:{type:'object'}}}],
    callTool:async call=>{assert.equal(runtime.limits().active,0);assert.equal(call.id,'call1');return {content:'approved data',isError:false};}});
  assert.equal(result.filter(c=>typeof c==='string').join(''),'done');
  assert.equal(requests[1].input.at(-1).type,'function_call_output');
  assert.equal(requests[1].input.at(-1).output,'approved data');
});

test('Responses rejects incomplete streams, provider errors and invalid configuration without leaking diagnostics', async () => {
  await assert.rejects(collect(new ResponsesRuntime(config,async()=>sse([{type:'response.output_text.delta',delta:'partial'}]))),{code:'PROVIDER_DISCONNECTED'});
  await assert.rejects(collect(new ResponsesRuntime(config,async()=>new Response('test-secret',{status:401}))), error=>error.code==='PROVIDER_HTTP_ERROR'&&!error.message.includes('test-secret'));
  await assert.rejects(collect(new ResponsesRuntime(config,async()=>{throw Error('test-secret');})), error=>error.code==='PROVIDER_TRANSPORT_ERROR'&&!error.message.includes('test-secret'));
  assert.throws(()=>new ResponsesRuntime({...config,maxKeyword:0}),{code:'INVALID_CONFIG'});
});

test('Responses disables hosted search for offline Skills and memory, and supports JSON fallback', async () => {
  const bodies=[];
  const runtime=new ResponsesRuntime(config,async(_,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify(completed([message('ok')])),{headers:{'content-type':'application/json'}});});
  await collect(runtime,{skillInstruction:'offline research'});await collect(runtime,{hostedSearch:false});
  assert.ok(bodies.every(b=>!b.tools.some(t=>t.type==='web_search')));
});

test('Responses serializes prior assistant answers as input messages for multi-turn Ark requests', async () => {
  let body;
  const runtime = new ResponsesRuntime(config, async (_, init) => {
    body = JSON.parse(init.body);
    if (body.input.some(message => message.content.some(part => part.type !== 'input_text'))) {
      return new Response(JSON.stringify({ error: { code: 'MissingParameter', param: 'input.type' } }), { status: 400 });
    }
    return sse([{ type: 'response.output_text.delta', delta: 'second answer' },
      { type: 'response.completed', response: completed([message('second answer')]) }]);
  });
  const result = await collect(runtime, { messages: [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ] });
  assert.deepEqual(body.input.map(item => item.role), ['user', 'assistant', 'user']);
  assert.equal(body.input[1].content[0].text, 'first answer');
  assert.equal(result.filter(item => typeof item === 'string').join(''), 'second answer');
});

test('Responses search and sources persist in Coordinator history and step events', {timeout:3000}, async()=>{
  const store=new SessionStore(':memory:');
  const runtime=new ResponsesRuntime(config,async()=>sse([{type:'response.output_text.delta',delta:'answer'}, {type:'response.completed',response:completed([search,message('answer')])}]));
  const coordinator=new RunCoordinator(store,runtime,()=>{});
  try {
    const run=coordinator.accept(store.create().id,'web','find a book');
    for(let i=0;i<100&&['queued','running'].includes(store.getRun(run.id).status);i++)await new Promise(r=>setTimeout(r,5));
    const saved=store.getRun(run.id);
    assert.equal(saved.status,'completed');assert.equal(saved.output,'answer');
    assert.deepEqual(JSON.parse(saved.providerTrace).map(e=>e.event),['web.search','web.sources']);
    assert.ok(store.eventsForRun(run.id).some(e=>e.type==='web.search'));
  } finally {await coordinator.shutdown();store.close();}
});

test('Responses rejects empty successful payload and cancellation retains abort reason', async()=>{
  await assert.rejects(collect(new ResponsesRuntime(config,async()=>sse([{type:'response.completed',response:completed([])}]))),{code:'PROVIDER_EMPTY_RESPONSE'});
  const controller=new AbortController();const reason=new Error('cancelled');controller.abort(reason);
  await assert.rejects(collect(new ResponsesRuntime(config),{signal:controller.signal}),error=>error===reason);
});

test('Ark search not activated exposes an actionable safe error after a generic error event', async () => {
  const runtime = new ResponsesRuntime(config, async () => sse([
    { type: 'error' },
    { type: 'response.failed', response: { status: 'failed', error: {
      code: 'ToolNotOpen', message: 'test-secret must never be included',
    } } },
  ]));
  await assert.rejects(collect(runtime), error =>
    error.code === 'WEB_SEARCH_NOT_ACTIVATED' && error.message.includes('CC_content_plugin') && !error.message.includes('test-secret'));
});
