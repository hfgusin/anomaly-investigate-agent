"""真实 create_agent / ToolNode，本地假模型，不连接外部服务。"""
import asyncio
from collections import deque
import json
import unittest
from unittest.mock import patch

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from agent_backend.middleware import GatewayRuntimeMiddleware
from langchain_core.tools import tool
from pydantic import SecretStr
from agent_backend import runtime, tools
from agent_backend.ark_model import ArkResponsesChatModel
from agent_backend.catalog import catalog


class ToolModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


class FrameworkTests(unittest.TestCase):
    def run_tool(self, approved, failure=False, mode="standard"):
        calls = []
        @tool
        def my_business_tool(value: str) -> str:
            """处理业务输入。"""
            calls.append(value)
            if failure:
                raise RuntimeError("service-secret")
            return f"processed:{value}"
        model = ToolModel(responses=[
            AIMessage(content="", tool_calls=[{"id": "one", "name": "my_business_tool", "args": {"value": "input"}}],
                      response_metadata={"finish_reason": "tool_calls"}),
            AIMessage(content="done", response_metadata={"finish_reason": "stop"}),
        ])
        request = runtime.StartRequest(type="start", messages=[{"role": "user", "content": "process"}],
                                       toolDefinitions=[{"function": {"name": "my_business_tool"}}],
                                       toolResultMode=mode)
        pending = deque()
        events = []
        def send(kind, **payload):
            events.append({"type": kind, **payload})
            if kind == "model_request":
                pending.append({"type": "model_allowed"})
            elif kind == "python_tool_call":
                pending.append({"type": "tool_approval", "id": payload["id"], "approved": True} if approved else
                               {"type": "tool_result", "id": payload["id"], "content": "denied", "denied": True, "isError": True})
            elif kind == "tool_executed":
                pending.append({"type": "tool_result", **payload})
        async def receive():
            return pending.popleft()
        with patch.object(tools, "TOOLS", [my_business_tool]), patch.dict("os.environ", {"MIRROR_RUNTIME": "chat-completions"}):
            self.assertEqual(catalog()[0]["definition"]["function"]["name"], "my_business_tool")
            self.assertEqual(catalog()[0]["risk"], "execute")
            messages = asyncio.run(runtime.run(request, model=model, send=send, recv=receive))
        return calls, events, messages

    def test_quota_notice_hides_queries_then_reserves_final_answer(self):
        @tool
        def query_fixture() -> str:
            """读取测试数据。"""
            return "ok"
        @tool
        def record_fixture() -> str:
            """保存测试记录。"""
            return "ok"
        record_fixture.metadata = {"budget_group": "record"}
        start = runtime.StartRequest(type="start", messages=[], toolDefinitions=[
            {"function": {"name": tool.name}} for tool in [query_fixture, record_fixture]])
        captured = []
        async def receive():
            return {"type": "model_allowed"}
        async def handler(request):
            captured.append(request)
            return ModelResponse(result=[AIMessage(content="已完成", response_metadata={"finish_reason": "stop"})])
        with patch.object(tools, "TOOLS", [query_fixture, record_fixture]):
            middleware = GatewayRuntimeMiddleware(start, responses=True, system="policy", send=lambda *_a, **_kw: None, recv=receive)
            request = ModelRequest(model=ToolModel(responses=[]), messages=[], tools=[query_fixture, record_fixture], system_message=SystemMessage(content="policy"))
            middleware.calls["query"] = 14
            asyncio.run(middleware.awrap_model_call(request, handler))
            self.assertIn("14/16", captured[-1].system_message.text)
            self.assertIn("请收尾", captured[-1].system_message.text)
            middleware.calls["query"] = 16
            asyncio.run(middleware.awrap_model_call(request, handler))
            self.assertEqual([tool.name for tool in captured[-1].tools], ["record_fixture"])
            middleware.model_calls = middleware.max_model_calls - 1
            asyncio.run(middleware.awrap_model_call(request, handler))
            self.assertEqual(captured[-1].tools, [])
            self.assertIn("最后一轮", captured[-1].system_message.text)

    def test_custom_tool_registered_and_executed_by_toolnode(self):
        calls, events, messages = self.run_tool(True)
        self.assertEqual(calls, ["input"])
        self.assertTrue(any(e["type"] == "tool_executed" and e["content"] == "processed:input" for e in events))
        self.assertEqual(messages[-2].content, "processed:input")
        self.assertEqual(messages[-2].tool_call_id, "one")

    def test_rejection_never_enters_custom_function(self):
        calls, events, messages = self.run_tool(False)
        self.assertEqual(calls, [])
        self.assertFalse(any(e["type"] == "tool_executed" for e in events))
        self.assertTrue(messages[-2].additional_kwargs["mirror"]["denied"])

    def test_plain_rejection_emits_answer_once(self):
        calls, events, messages = self.run_tool(False, mode="plain")
        self.assertEqual(calls, [])
        self.assertEqual([e["text"] for e in events if e["type"] == "text"],
                         ["用户拒绝了工具调用；工具没有执行，因此我无法根据该工具的结果回答。"])
        self.assertEqual(messages[-1].text, "用户拒绝了工具调用；工具没有执行，因此我无法根据该工具的结果回答。")

    def test_responses_tool_round_replays_function_call_and_streams_answer(self):
        bodies = []
        class FakeArk(ArkResponsesChatModel):
            async def _events(self, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield {"type": "response.output_item.done", "item": {
                        "type": "web_search_call", "id": "ws1", "status": "completed",
                        "action": {"query": "example"}}}
                    yield {"type": "response.output_text.delta", "delta": "先查一下"}
                    yield {"type": "response.completed", "response": {"status": "completed", "output": [
                        {"type": "web_search_call", "id": "ws1", "status": "completed",
                         "action": {"query": "example"}},
                        {"type": "message", "content": [{"type": "output_text", "text": "先查一下",
                         "annotations": [{"type": "url_citation", "url": "https://example.com", "title": "Example"}]}]},
                        {"type": "function_call", "call_id": "c1", "name": "greet_user", "arguments": '{"name": "Yara"}'}]}}
                else:
                    yield {"type": "response.output_text.delta", "delta": "好"}
                    yield {"type": "response.completed", "response": {"status": "completed", "output": [
                        {"type": "message", "content": [{"type": "output_text", "text": "好"}]}]}}
        request = runtime.StartRequest(type="start", messages=[{"role": "user", "content": "hi"}],
                                       toolDefinitions=[{"function": {"name": "greet_user"}}])
        pending, events = deque(), []
        def send(kind, **payload):
            events.append({"type": kind, **payload})
            if kind == "model_request":
                pending.append({"type": "model_allowed"})
            elif kind == "python_tool_call":
                pending.append({"type": "tool_approval", "id": payload["id"], "approved": True})
            elif kind == "tool_executed":
                pending.append({"type": "tool_result", **payload})
        async def receive():
            return pending.popleft()
        model = FakeArk(base_url="http://fixture", model="fixture", api_key=SecretStr(""))
        with patch.dict("os.environ", {"MIRROR_RUNTIME": "responses"}):
            messages = asyncio.run(runtime.run(request, model=model, send=send, recv=receive))
        self.assertEqual([item.get("type") or item.get("role") for item in bodies[1]["input"]],
                         ["user", "web_search_call", "message", "function_call", "function_call_output"])
        self.assertEqual([e for e in events if e["type"] in ("text", "discard")],
                         [{"type": "text", "text": "先查一下"}, {"type": "discard", "chars": 4}, {"type": "text", "text": "好"}])
        provider_events = [e for e in events if e["type"] == "provider_event"]
        self.assertEqual([e["event"] for e in provider_events], ["web.search", "web.sources", "agent.action"])
        self.assertLess(events.index(provider_events[0]),
                        next(i for i, event in enumerate(events) if event == {"type": "text", "text": "先查一下"}))
        self.assertEqual(provider_events[1]["payload"]["sources"][0]["url"], "https://example.com")
        self.assertEqual(messages[-1].text, "好")

    def test_responses_json_200_fallback(self):
        class FakeResponse:
            status_code = 200
            headers = {"content-type": "application/json"}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                pass

            async def aiter_bytes(self):
                yield json.dumps({"status": "completed", "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]}).encode()

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                pass

            def stream(self, *_args, **_kwargs):
                return FakeResponse()

        model = ArkResponsesChatModel(base_url="http://fixture", model="fixture", api_key=SecretStr(""))
        async def collect():
            return [chunk async for chunk in model._astream([HumanMessage(content="hi")])]
        with patch("agent_backend.ark_model.httpx.AsyncClient", return_value=FakeClient()):
            chunks = asyncio.run(collect())
        self.assertTrue(any(chunk.message.content == "ok" for chunk in chunks))
        self.assertEqual(chunks[-1].message.response_metadata["finish_reason"], "stop")

    def test_custom_execute_failure_stops_safe_replay_and_hides_exception_body(self):
        calls, events, _ = self.run_tool(True, failure=True)
        result = next(e for e in events if e["type"] == "tool_executed")
        self.assertEqual(calls, ["input"])
        self.assertTrue(result["isError"])
        self.assertTrue(result["effectUnknown"])
        self.assertNotIn("service-secret", json.dumps(events))


if __name__ == "__main__":
    unittest.main()
