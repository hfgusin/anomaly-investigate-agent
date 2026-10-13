"""
对应：src/runtime.ts 里的 DemoRuntime

演示模式：不调模型，把用户最后一句话回声回去，用来测 Gateway 排队/中止。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class ChatMessage:
    role: str
    content: str


@dataclass
class RuntimeInfo:
    kind: str = "demo"
    label: str = "演示模式 · 未连接模型"
    model: str | None = None


class DemoRuntime:
    info = RuntimeInfo()

    async def stream(self, messages: list[ChatMessage], signal: asyncio.Event | None = None) -> AsyncIterator[str]:
        last = messages[-1].content if messages else ""
        reply = f"【演示回声】收到：{last}\n\n会话、排队和停止可以体验；真实回答需要配置模型接口。"
        for i in range(0, len(reply), 4):
            if signal and signal.is_set():
                raise asyncio.CancelledError()
            yield reply[i : i + 4]
            await asyncio.sleep(0.035)
