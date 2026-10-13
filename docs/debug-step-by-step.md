# 在 IDE 一步步读 Python Agent

先学习简单工具，推荐 [Python 工具开发](python-tools.md) 的 Playground。
VS Code 选择“Python：工具 Playground”，在 `tools/example.py` 的 return 行打断点，F5。
调用链是 `playground.main → build_agent → create_agent → ToolNode → greet_user`。
`messages` 保存完整 HumanMessage、AIMessage（tool_calls）、ToolMessage；可继续追问。

## 调试与网页共用的 DI 运行入口

打开 `python/debug_agent.py`，选择“Python：逐步学习 Agent”，按 F5。
PyCharm 使用 `.venv-di/bin/python`，右键该文件 Debug。
这个入口复用生产 `runtime.run`，替换网页传输与审批，不包含 SQLite 排队与共享限流。

文件顶部 `QUESTION` 是首轮问题。`APPROVE_DI_QUERY` 为 True 时允许执行真实 DI，False 时只观察拒绝后的模型回答；按当前文件实际值运行。

| 断点位置 | 查看内容 |
|---|---|
| debug_agent.py 的 raw_request | 本轮问题、Skill、工具定义 |
| runtime.py 的 create_model | 模型客户端配置 |
| runtime.py 的 run | system、messages、tools |
| agent.py 的 build_agent | 标准 create_agent 与 middleware |
| middleware.py 的 awrap_model_call | 模型请求与工具列表过滤 |
| DebugGateway.send 的 python_tool_call 分支 | 工具名、参数与批准/拒绝 |
| middleware.py 的 await handler | 批准后进入 ToolNode 的实际执行 |
| di_tool.py 的 di_query_sql / di_export_table | 你写的 @tool 函数 |
| DebugGateway.send 的 tool_executed 分支 | Python 返回的真实执行结果 |
| debug_agent.py 的 final_answer | history、gateway.events 与最终回答 |

F10 执行当前行，F11 进入函数，Shift+F11 退出，F5 继续。
`history` 保存完整 LangChain 消息；`/reset` 清空，`/exit` 退出。
审批入口本身不会调用 DI 函数，真正的工具函数由 ToolNode 执行。

业务工具统一在 `agent_backend/tools/__init__.py` 的 TOOLS 注册。Debug 的 DI 清单从 TOOLS 过滤，网页目录从同一清单自动生成。
DI 执行器内部保留已有重试与查询状态逻辑；submitted 用原 query_id 查询 status，unknown 不自动重复提交。
