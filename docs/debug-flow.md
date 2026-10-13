# 看真实请求如何流转

先在原来的服务终端按 Ctrl+C，再启动：

```sh
cd /Users/yara.huang/Documents/ui/openclaw-mirror
npm run debug
```

打开原本的 http://127.0.0.1:18789，发问题，后台终端会依次显示接收请求、任务状态、上下文、模型输出、工具请求、审批状态、工具回填和终态。

希望看问题内容、工具参数与结果节选：

```sh
DEBUG_CONTENT=1 npm run debug
```

日志也保存到 `.data/debug/flow-时间戳.jsonl`（本机，已被 Git 忽略）。默认只显示流程摘要；内容模式会包含你的业务内容节选。已知环境密钥和敏感字段会遮盖，但不是通用敏感数据识别器。输出节选上限4000字符、数组30项，文件上限10MB；日志里的节选不能当作完整模型请求。每段模型调用有 traceId，每个任务有 runId，适用于交错的并发任务。

这个文件启动真实 Gateway，不是模拟 Agent。网页审批与 DI 会话校验保持原样，不自动批准查询。不需要更改 `.env` 的模型配置。

## 读代码 / 打断点的位置

1. `src/gateway.ts` 的 `attach`：收到 WebSocket 请求，解析 method/params。
2. `src/run-coordinator.ts` 的 `accept`：将问题存入 SQLite、进入逐会话队列。
3. 同文件 `execute`：选择 Skill、组装 messages、提供工具定义。
4. `src/providers/langchain.ts` 的 `stream`：启动 Python 子进程，发送 start。
5. `python/agent_backend/runtime.py` 的 `run`：SystemMessage + 历史消息，模型 astream；模型每轮申请并释放许可。
6. Python 发 tool_call → TS `callTool` 等审批 → ToolRegistry 执行。
7. 返回 tool_result → Python 加入 ToolMessage → 再次 astream → 最终 done。

调试入口里的 `await input.callTool(call)` 会等待你在网页允许/拒绝。看到“工具请求”却没有“结果回填”，先查看网页是否在等待审批。

入口是 JavaScript，因为网页请求首先由现有 TS Gateway 接收；真正的模型与工具循环继续使用现有 Python LangChain。普通 IDE 在此 Node 启动器上的断点不会自动附着到 Python 子进程。

退出调试服务后可以重新 `npm start`。调试入口使用正常数据库，不要与 `pnpm dev` 同时启动。
