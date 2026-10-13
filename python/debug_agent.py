"""在 IDE 中逐步执行真实 Python Agent；不是终端日志追踪器。

VS Code：选“Python：逐步学习 Agent”后 F5。
PyCharm：选择 .venv-di/bin/python，右键此文件 Debug，并在标注处打断点。
复用 agent_backend.runtime.run；仅用本文件替代 Gateway 的跨进程收发。
"""
import asyncio
import json
from collections import deque
from pathlib import Path

from dotenv import load_dotenv
from langchain_core.utils.function_calling import convert_to_openai_tool

from agent_backend import runtime
from agent_backend.tools import TOOLS
from di_models import REQUEST
from di_export import build_sql

ROOT = Path(__file__).resolve().parents[1]

# 先运行这个问题，回答后可以继续输入追问；历史保留到 /reset 或退出。
DI_QUESTION = """你试试读取这个 sql：select distinct
    -- grass_region,
    item_id
    ,campaign_id
    -- ,ads_id
    ,count(1)
from mp_paidads.dim_advertise__reg_s0_live a
where
    tz_type = 'local'
    and grass_date >= current_date - interval '1' day
    and is_ads_active != 0
    and campaign_status_text = 'ADS_NORMAL'
    and sub_product_type = 'gmv_shop_max'
    and shop_id not in (
        1006215031
        ,188678203
        ,196214868
        ,1006220784
        ,196268298
        ,196261835
        ,1179967114
    )
  
group by 1, 2 然后导出全量csv，保存到 本地并给我地址"""
QUESTION = ""  # 留空启动后自己输入；原 SQL 示例保留在 DI_QUESTION。
DEBUG_SKILL = "daily-check"  # 改为 growth 可学习原成长主题；空字符串为通用模式。
APPROVE_DI_QUERY = None  # None 逐次询问；True/False 只控制 DI，不自动批准其他工具。


class DebugGateway:
    """只替代消息传输与审批，不重写模型/工具循环。可以展开 self 看所有状态。"""

    def __init__(self, approve=None):
        self.pending = deque()
        self.events = []
        self.answer_chunks = []
        self.last_tool_arguments = None
        self.last_sql = None
        self.last_tool_result = None
        self.approve = approve

    def send(self, kind, **payload):
        frame = {"type": kind, **payload}  # 断点 C：Python 发出了什么消息？
        self.events.append(frame)
        if kind == "model_request":
            # 真网页中由 TS 的共享限流器决定；本地单请求学习入口直接允许。
            self.pending.append({"type": "model_allowed"})
        elif kind == "tool_executed":
            self.last_tool_result = payload
            self.pending.append({"type": "tool_result", **payload})
        elif kind == "python_tool_call":
            tool_arguments = json.loads(payload["arguments"])
            name = payload["name"]
            if DEBUG_SKILL == "growth" and name in {"di_export_table", "di_query_sql"}:
                tool_arguments["topic_id"] = "growth"
            self.last_tool_arguments = tool_arguments
            self.last_sql = tool_arguments.get("sql")
            if name == "di_export_table" and tool_arguments.get("action") == "execute":
                try:
                    self.last_sql = build_sql(REQUEST.validate_python(tool_arguments).model_dump(exclude_none=True))[0]
                except ValueError:
                    self.last_sql = None  # 真正的参数校验留给生产 ToolNode。
            if self.approve is not None:
                approved = self.approve(name, tool_arguments)
            elif name in {"di_export_table", "di_query_sql"} and APPROVE_DI_QUERY is not None:
                approved = APPROVE_DI_QUERY
            else:
                print(f"\n工具：{name}\n参数：{json.dumps(tool_arguments, ensure_ascii=False, indent=2)}")
                approved = input("批准执行？输入 y 批准，其余拒绝：").strip().lower() == "y"
            if approved:
                self.pending.append({"type": "tool_approval", "id": payload["id"], "approved": True,
                                     "arguments": tool_arguments})
            else:
                self.pending.append({"type": "tool_result", "id": payload["id"],
                                     "content": "用户拒绝了这次工具调用。", "isError": True, "denied": True})
        elif kind == "tool_call":
            self.pending.append({"type": "tool_result", "id": payload["id"], "isError": True,
                                 "content": "此调试入口仅执行 Python 工具；TS 平台工具需要网页 Gateway。"})
        elif kind == "provider_event" and payload.get("event") == "agent.action":
            print("行动说明：", payload["payload"]["text"])
        elif kind == "text":
            self.answer_chunks.append(payload["text"])
        elif kind == "discard":
            # 与网页一样撤回模型工具调用前的草稿，chars 按 UTF-16 计。
            text = "".join(self.answer_chunks).encode("utf-16-le")
            self.answer_chunks = [text[:len(text) - payload["chars"] * 2].decode("utf-16-le")]

    async def receive(self):
        # 这里只批准/拒绝；实际函数由生产 runtime 的 ToolNode 执行。
        return self.pending.popleft()


async def main():
    load_dotenv(ROOT / ".env", override=True)  # 每次重启 Debug 都读取最新 .env。
    # 与生产桥一致，关闭隐式云端 tracing。
    import os
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    os.environ["LANGSMITH_TRACING"] = "false"
    skill = (ROOT / "skills" / DEBUG_SKILL / "SKILL.md").read_text() if DEBUG_SKILL else ""
    if DEBUG_SKILL == "growth":
        topic = json.loads((ROOT / "data/topics/growth.json").read_text())
        skill += "\n主题表路由与口径：\n" + json.dumps(topic, ensure_ascii=False)
    model = runtime.create_model()  # 断点 B：F11 进入，看 .env 如何决定模型客户端。
    history = []  # LangChain HumanMessage / AIMessage / ToolMessage；IDE 中展开看。
    question = QUESTION
    turn_number = 0
    while True:
        if question == "/exit":
            return history
        if question == "/reset":
            history.clear()
            turn_number = 0
        elif question.strip():
            turn_number += 1
            raw_request = {  # 断点 A：本轮新问题；历史在下面 history 变量中。
                "type": "start",
                "messages": [{"role": "user", "content": question}],
                "toolDefinitions": [convert_to_openai_tool(registered_tool) for registered_tool in TOOLS],
                "skillInstruction": skill or None,
                "hostedSearch": False,
                "toolResultMode": "standard",
                "maxToolResultChars": 100000,
            }
            request = runtime.StartRequest.model_validate(raw_request)
            gateway = DebugGateway()  # 每轮新的传输状态；对话历史不清除。
            # F11：同一个生产 Runtime；结束后取得完整 LangChain 消息历史。
            history = await runtime.run(request, model=model, send=gateway.send,
                                        recv=gateway.receive, history=history)
            final_answer = "".join(gateway.answer_chunks)  # 断点 G：同时查看 history 和工具结果。
            print(final_answer)
        try:
            question = input("\n继续提问（/reset 清空历史，/exit 退出）：").strip()
        except (EOFError, KeyboardInterrupt):
            return history


if __name__ == "__main__":
    asyncio.run(main())
