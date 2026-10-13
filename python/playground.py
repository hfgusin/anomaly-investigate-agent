"""最小 Python LangChain 学习入口：模型 → @tool → 模型，无网页协议。"""
import asyncio
import os
from pathlib import Path
from dotenv import load_dotenv

from agent_backend.agent import build_agent
from agent_backend.runtime import create_model, POLICY
from agent_backend.tools import TOOLS


async def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=True)
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    os.environ["LANGSMITH_TRACING"] = "false"
    # IDE 断点 1：查看模型配置、TOOLS 中的工具对象。
    agent = build_agent(create_model(), TOOLS, POLICY)
    messages = []
    question = "请调用 greet_user，名字是 Yara"
    while True:
        # IDE 断点 2：展开 messages；F11 后模型会选择工具。
        result = await agent.ainvoke({"messages": [*messages, {"role": "user", "content": question}]})
        messages = result["messages"]
        print(messages[-1].content)
        try:
            question = input("继续提问（/exit 退出，/reset 清空）：").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if question == "/exit":
            break
        if question == "/reset":
            messages = []
            question = "请调用 greet_user，名字是 Yara"


if __name__ == "__main__":
    asyncio.run(main())
