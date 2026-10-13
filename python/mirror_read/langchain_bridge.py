"""
对应：src/providers/langchain.ts（Node 父进程侧逻辑，用 Python 写出来方便读）

真实代码在 TypeScript 里用 child_process.spawn 跑：
  python -m agent_backend.runtime
工作目录：仓库 python/

子进程协议（一行一个 JSON，stdout 只能打协议，stderr 打诊断）：
  父 → 子：{ "type": "start", "messages", "toolDefinitions", "maxToolResultChars", ... }
  子 → 父：text | tool_call | model_request | model_release | done | error
  父 → 子：{ "type": "model_allowed" }  （Gateway 限流通过后才允许调模型）
  父 → 子：{ "type": "tool_result", "id", "content", ... }  （工具在 TS Gateway 里执行）

下面用 async 生成器模拟「父进程读子进程 stdout」时的分支，与 langchain.ts 的 switch(event.type) 一致。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from typing import Any, AsyncIterator, Awaitable, Callable


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class EventType(str, Enum):
    MODEL_REQUEST = "model_request"
    MODEL_RELEASE = "model_release"
    TEXT = "text"
    DISCARD = "discard"
    PROVIDER_EVENT = "provider_event"
    TOOL_CALL = "tool_call"
    DONE = "done"
    ERROR = "error"


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


ToolHandler = Callable[[ToolCall], Awaitable[dict[str, Any]]]
TakeLimiter = Callable[[], Callable[[], None]]  # take() -> release


async def consume_python_events(
    lines: AsyncIterator[str],
    *,
    take_model_slot: TakeLimiter,
    call_tool: ToolHandler | None,
    max_line_len: int = 2_000_000,
    max_frames: int = 200_000,
) -> AsyncIterator[str | dict[str, Any]]:
    """
    把子进程 stdout 每一行 JSON 转成 Gateway 需要的 chunk：
      - str：流式文本
      - {"type":"discard","chars":n}
      - {"type":"provider_event",...}
    """
    release: Callable[[], None] | None = None
    frame_count = 0

    async for line in lines:
        frame_count += 1
        if len(line) > max_line_len or frame_count > max_frames:
            raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 事件超过限制。")
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 返回无效事件。")
        if not isinstance(event, dict):
            raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 事件格式错误。")

        kind = event.get("type")
        if kind == EventType.MODEL_REQUEST.value:
            if release is not None:
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "模型许可未释放。")
            release = take_model_slot()
            yield {"_bridge": "model_allowed"}  # 真实 TS 会 stdin.write model_allowed
            continue
        if kind == EventType.MODEL_RELEASE.value:
            if release is None:
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "没有待释放的模型许可。")
            release()
            release = None
            continue
        if kind == EventType.TEXT.value:
            text = event.get("text")
            if not isinstance(text, str):
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 文本事件无效。")
            yield text
            continue
        if kind == EventType.DISCARD.value:
            chars = event.get("chars")
            if not isinstance(chars, int) or chars < 0:
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 撤回事件无效。")
            yield {"type": "discard", "chars": chars}
            continue
        if kind == EventType.PROVIDER_EVENT.value:
            if event.get("event") not in ("web.search", "web.sources"):
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 搜索事件无效。")
            yield {"type": "provider_event", "event": event["event"], "payload": event.get("payload") or {}}
            continue
        if kind == EventType.TOOL_CALL.value:
            if call_tool is None or release is not None:
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 工具调用无效。")
            tc = ToolCall(
                id=event.get("id", ""),
                name=event.get("name", ""),
                arguments=event.get("arguments", ""),
            )
            if not tc.id or not tc.name or len(tc.arguments.encode("utf-8")) > 8192:
                raise BridgeError("LANGCHAIN_BRIDGE_ERROR", "Python 工具调用无效。")
            result = await call_tool(tc)
            yield {"_bridge": "tool_result", "id": tc.id, **result}
            continue
        if kind == EventType.DONE.value:
            return
        if kind == EventType.ERROR.value:
            raise BridgeError(event.get("code", "LANGCHAIN_RUNTIME_ERROR"), str(event.get("message", "")))
        raise BridgeError("LANGCHAIN_BRIDGE_ERROR", f"未知事件类型：{kind}")
