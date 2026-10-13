"""Ark Responses -> LangChain BaseChatModel.

Ark 的 web_search/max_keyword/thinking 是供应商扩展，不能丢掉。
此适配器保留 Responses 原始 output，用于下一轮函数结果回填。
"""
import codecs
import json
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr
from langchain_core.language_models.chat_models import BaseChatModel, agenerate_from_stream
from langchain_core.messages import AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.utils.function_calling import convert_to_openai_tool


class BackendError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def source_url(value):
    try:
        parts = urlsplit(value)
        return isinstance(value, str) and parts.scheme in ("http", "https") and bool(parts.hostname) and not parts.username and not parts.password
    except (ValueError, TypeError):
        return False


def search_evidence(item):
    action = item.get("action") or {}
    queries = action.get("queries") or [action.get("query")]
    return {"id": str(item.get("id", ""))[:200], "status": str(item.get("status", "unknown")),
            "queries": [q[:600] for q in queries if isinstance(q, str)][:5],
            "execution": "方舟服务端内置搜索；不是本地函数审批"}


async def response_events(response):
    """有界、跨网络分片的 UTF-8/SSE 解码；截断不能当作成功。"""
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    buffer = ""
    total = 0
    data = []
    async for raw in response.aiter_bytes():
        total += len(raw)
        if total > 8_000_000:
            raise BackendError("PROVIDER_TOO_LARGE", "Responses 流超过限制。")
        buffer += decoder.decode(raw)
        if len(buffer) > 1_000_000:
            raise BackendError("PROVIDER_TOO_LARGE", "Responses 单帧超过限制。")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.removesuffix("\r")
            if not line:
                if data:
                    payload = "\n".join(data)
                    data = []
                    if payload != "[DONE]":
                        yield json.loads(payload)
            elif line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
    buffer += decoder.decode(b"", final=True)
    if buffer.strip() or data:
        raise BackendError("PROVIDER_DISCONNECTED", "Responses 流在完整事件之前断开。")


class ArkResponsesChatModel(BaseChatModel):
    base_url: str
    model: str
    api_key: SecretStr
    thinking: str | None = None
    timeout: float = 90

    @property
    def _llm_type(self):
        return "ark-responses"

    @property
    def _identifying_params(self):
        return {"model": self.model, "api": "responses"}

    def bind_tools(self, tools, **kwargs):
        definitions = []
        for tool in tools:
            if isinstance(tool, dict) and tool.get("type") == "web_search":
                definitions.append(tool)
            else:
                definitions.append({"type": "function", **convert_to_openai_tool(tool)["function"]})
        return self.bind(tools=definitions, **kwargs)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise NotImplementedError("此后端使用 async：请使用 ainvoke/astream。")

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return await agenerate_from_stream(self._astream(messages, stop, run_manager, **kwargs))

    def _payload(self, messages, tools):
        """LangChain 消息 -> Responses 请求体。上一轮的 ark_output 原样回填，函数调用才能对上结果。"""
        instructions, history = [], []
        for message in messages:
            if message.type == "system":
                instructions.append(message.text)
            elif isinstance(message, ToolMessage):
                history.append({"type": "function_call_output", "call_id": message.tool_call_id, "output": message.content})
            elif message.type == "ai" and message.additional_kwargs.get("ark_output"):
                history.extend(message.additional_kwargs["ark_output"])
            else:
                history.append({"role": "assistant" if message.type == "ai" else "user",
                                "content": [{"type": "input_text", "text": message.text}]})
        body = {"model": self.model, "stream": True, "store": False,
                "instructions": "\n\n".join(instructions), "input": history, "tools": tools}
        if self.thinking:
            body["thinking"] = {"type": self.thinking}
        return body

    async def _events(self, body):
        """POST Responses，逐个产出 SSE 事件或完整 JSON 响应。"""
        endpoint = self.base_url.rstrip("/")
        if not endpoint.endswith("/responses"):
            endpoint += "/responses"
        headers = {"accept": "text/event-stream"}
        if self.api_key.get_secret_value():
            headers["authorization"] = "Bearer " + self.api_key.get_secret_value()
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            async with client.stream("POST", endpoint, json=body, headers=headers) as response:
                if response.status_code != 200:
                    raise BackendError("PROVIDER_RATE_LIMITED" if response.status_code == 429 else "PROVIDER_HTTP_ERROR",
                                       f"Responses 接口返回 HTTP {response.status_code}，未保存服务商错误正文。")
                if "application/json" in response.headers.get("content-type", ""):
                    raw = bytearray()
                    async for part in response.aiter_bytes():
                        raw.extend(part)
                        if len(raw) > 2_000_000:
                            raise BackendError("PROVIDER_TOO_LARGE", "Responses 正文超过限制。")
                    yield {"type": "response.completed", "response": json.loads(raw)}
                else:
                    async for event in response_events(response):
                        yield event

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        text = ""
        completed = None
        searches = set()
        async for event in self._events(self._payload(messages, kwargs.get("tools", []))):
            kind = event.get("type")
            if kind == "response.output_text.delta" and isinstance(event.get("delta"), str):
                text += event["delta"]
                yield ChatGenerationChunk(message=AIMessageChunk(content=event["delta"]))
            elif kind == "response.output_item.done" and event.get("item", {}).get("type") == "web_search_call":
                searches.add(event["item"].get("id"))
                yield self.event_chunk("web.search", search_evidence(event["item"]))
            elif kind == "response.completed":
                completed = event.get("response")
            elif kind in ("response.failed", "response.incomplete", "error"):
                code = (event.get("response", {}).get("error") or event.get("error") or {}).get("code") or event.get("code")
                if code == "ToolNotOpen":
                    raise BackendError("WEB_SEARCH_NOT_ACTIVATED", "方舟账号尚未开通联网搜索，没有取得网页证据。")
                raise BackendError("PROVIDER_INCOMPLETE", "Responses 未成功完成；已保留部分输出。")
        if not completed or completed.get("status") != "completed" or not isinstance(completed.get("output"), list):
            raise BackendError("PROVIDER_DISCONNECTED", "未收到成功的 Responses 完成事件。")
        for chunk in self._final_chunks(completed["output"], text, searches):
            yield chunk

    def _final_chunks(self, output, streamed_text, searches):
        """完成事件里的 output 才是权威结果：补发未流出的正文、引用来源，最后一块带 tool_calls。"""
        final_text = ""
        sources = {}
        calls = []
        for item in output:
            if item.get("type") == "web_search_call" and item.get("id") not in searches:
                yield self.event_chunk("web.search", search_evidence(item))
            if item.get("type") == "function_call":
                raw_args = item.get("arguments")
                if not item.get("call_id") or not item.get("name") or not isinstance(raw_args, str) or len(raw_args) > 8192:
                    raise BackendError("PROVIDER_PROTOCOL_ERROR", "Responses 函数调用无效。")
                args = json.loads(raw_args)
                if not isinstance(args, dict):
                    raise BackendError("PROVIDER_PROTOCOL_ERROR", "工具参数必须是对象。")
                calls.append({"name": item["name"], "args": args, "id": item["call_id"], "type": "tool_call"})
            if item.get("type") == "message":
                for content in item.get("content", []):
                    if content.get("type") != "output_text":
                        continue
                    final_text += content.get("text", "")
                    for annotation in content.get("annotations", []):
                        if annotation.get("type") != "url_citation":
                            continue
                        citation = annotation.get("url_citation") or annotation
                        url = citation.get("url")
                        if source_url(url):
                            sources[url] = {"url": url, "title": str(citation.get("title") or urlsplit(url).hostname)[:300]}
        if streamed_text and streamed_text != final_text:
            raise BackendError("PROVIDER_PROTOCOL_ERROR", "Responses 流文本与完成正文不一致。")
        if not streamed_text and final_text:
            yield ChatGenerationChunk(message=AIMessageChunk(content=final_text))
        if sources:
            yield self.event_chunk("web.sources", {"sources": list(sources.values())[:30]})
        if not calls and not final_text.strip():
            raise BackendError("PROVIDER_EMPTY_RESPONSE", "Responses 完成事件中没有回答正文。")
        yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_calls=calls,
            additional_kwargs={"ark_output": output},
            response_metadata={"finish_reason": "tool_calls" if calls else "stop"}))

    @staticmethod
    def event_chunk(name: str, payload: dict[str, Any]):
        return ChatGenerationChunk(message=AIMessageChunk(content="",
            additional_kwargs={"provider_events": [{"event": name, "payload": payload}]}))
