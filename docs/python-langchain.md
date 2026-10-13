# Python / LangChain 迁移：第一阶段

## 已接入的运行链路

启动入口仍是 `pnpm dev → tsc → node dist/server.js`。真实模型配置 `AGENT_ENGINE=langchain` 时，`readConfig()` 选择 `LangChainRuntime`，它启动 `python -m agent_backend.runtime`，实际模型循环运行在 `runtime.py`。`src/runtime.ts` 的 `AgentRuntime` 是编译期接口；其中 `DemoRuntime` 只在 `MIRROR_RUNTIME=demo` 时执行。设置 `AGENT_ENGINE=native` 才会改走旧 TS 模型实现。

```text
网页 / CLI
  → TS Gateway：会话、SQLite、逐会话队列、审批、停止和恢复
  → TS LangChainRuntime：逐行 JSON 进程通信、共享模型限流
  → Python runtime：LangChain create_agent、模型流与 Agent middleware
  → 模型要求工具
  → Agent 内置 ToolNode → TS Coordinator：写入调用记录、等待审批、执行已有工具
  → ToolNode 生成 ToolMessage，Agent 继续模型生成
  → 原网页流式显示
```

这一阶段迁移的是主 Agent 的模型调用与工具循环。Gateway、SQLite、Skills/Memory 数据管理、Airflow/研究/文件等工具执行、RAG 索引及独立中文回答、自动化看板仍由现有 TS 模块负责。DI 查询与 CSV 导出此前已在 Python。运行时已使用 LangChain `create_agent` 及其内置 `ToolNode`，但没有迁移为 LangGraph checkpointer。

LangChain 使用其真实 Agent、消息与工具接口：`create_agent`、`HumanMessage`、`AIMessage`、`ToolMessage`、`StructuredTool` 和 `ChatOpenAI`。`GatewayRuntimeMiddleware` 把 ToolNode 的调用转交 Gateway 审批和执行；Python 不持有绕过审批的本地执行器。

DI 已注册为 Python `StructuredTool`，脚本入口同样通过 `invoke()` 执行；网络读取的自定义安全重试中间件及失败原因记录见 [DI 工具说明](di-export.md#langchain-工具与失败重试)。

## 代码阅读顺序

1. `python/agent_backend/runtime.py`：`create_model()` 选模型；`run()` 创建标准 Agent，用 `astream_events(version="v3")` 运行，`forward_stream()` 把 `stream.messages` 里每次模型调用的文字增量、搜索事件转发给 TS；`GatewayRuntimeMiddleware` 负责模型限流、Gateway 工具审批和预算边界，工具循环由 Agent 内置 ToolNode 完成。v3 会把 `AIMessage.content` 存成内容块列表，读正文统一用 `message.text`。v3 在 LangGraph 中标记为实验性，升级依赖后先跑 `tests/langchain.test.mjs`。
2. `python/agent_backend/ark_model.py`：方舟 Responses 的 LangChain `BaseChatModel` 适配器。`_payload` 把消息转成请求体，`_events` 发请求并解析 SSE，`_astream` 产出文字和搜索事件，`_final_chunks` 从完成事件取工具调用、引用来源和原始 output（`ark_output`，下一轮回填用）。保留 `web_search`、`max_keyword`、`thinking`。只支持异步，同步接口未实现。搜索事件挂在 chunk 的 `additional_kwargs` 上，v3 下要等该次模型调用结束才转发。
3. `src/providers/langchain.ts`：过渡桥。每个运行创建一个 Python 子进程；只在每轮模型 HTTP 请求期间占用限流名额。审批期间释放名额，停止会终止对应 Python 进程。
4. `src/config.ts`：默认 `AGENT_ENGINE=langchain`，原来的 `MIRROR_RUNTIME` 继续决定 Responses 或 Chat Completions。

Chat Completions 使用 `ChatOpenAI`，关闭 SDK 自动重试。方舟包含供应商扩展，使用自定义 LangChain 模型适配器；不把非标准参数静默丢掉。协议参考：[ChatOpenAI](https://reference.langchain.com/python/langchain-openai/langchain_openai/chat_models/base/ChatOpenAI)、[BaseChatModel](https://reference.langchain.com/python/langchain-core/language_models/chat_models/BaseChatModel)。

## 环境与启动

当前机器已经安装好依赖，DI 和 Agent 暂时共用 `.venv-di`。从项目根目录启动仍为：

```bash
pnpm dev
```

若没有 pnpm，可以使用现有 npm：

```bash
npm run build
npm start
```

`.env` 增加：

```dotenv
AGENT_ENGINE=langchain
AGENT_PYTHON=/Users/yara.huang/Documents/ui/openclaw-mirror/.venv-di/bin/python
```

模型 URL、名称和密钥沿用已有 `MODEL_*` 配置。修改后重启服务。`AGENT_ENGINE=native` 可以切回之前的 TS 模型实现作对照；不要同时启动两个连接同一数据库的 Gateway。

新机器安装当前锁定版本：

```bash
uv venv .venv-di
uv pip install --python .venv-di/bin/python -r python/requirements.lock.txt
```

`requirements.txt` 是直接依赖范围，`requirements.lock.txt` 保存本次安装版本。Python 子进程关闭 LangSmith 云端 tracing，stdout 只传协议事件，不打印 prompt、工具结果或密钥。

## 你在页面检查

重启原服务后，页面的模型名称会包含 **Python LangChain**。

| 输入 / 操作 | 预期 | 检查证据 |
|---|---|---|
| `只回复 LANGCHAIN-OK` | 流式返回文本 | 模型标签包含 Python LangChain |
| `调用 read_file 读取 agent_demo.txt，只回答项目代号` | 停在审批；允许后回答 Cedar-731 | read_file 调用记录为 completed |
| 同样问题，点击拒绝 | 说明工具未执行 | 调用记录为 rejected，没有文件结果 |
| `联网查询 Python 官方网站，给出地址及来源` | 有官网地址与出处 | web.search 和 web.sources 事件 |
| 输出过程中点停止 | 运行停止，保留已输出片段 | 原有停止终态；模型活跃请求数归零 |
| `查询已有 DI 导出的状态`并提供 query_id | 沿用现有工具审批和 CSV 下载 | Python DI 记录与原下载接口 |

## 已验证与限制

2026-10-08：13 项受控检查通过，覆盖两种 API 的文本、函数回填、拒绝、异常断流、HTTP 错误、取消、DI StructuredTool，以及 plain 拒绝和成功回填。实际启动 Python 子进程、使用 LangChain Agent/ToolNode 并连接临时本机模型服务；不是仅编译或仅模拟桥函数。

完整工程回归为 149/149 通过。生产 Gateway 的审批行为没有因此修改。回归命令为 `node --test tests/*.test.mjs`，需先编译 TS。

真实 `.env` 模型已返回 LANGCHAIN-OK。内存 SQLite 的真实 Coordinator 检查通过：read_file 经明确审批执行，再回填模型，最终回答 Cedar-731。证据在 `.data/langchain-migration/real-check.json`。没有改动现有会话数据库，也没有重启用户正在使用的服务。

真实方舟联网搜索也通过：返回 Python 官网地址，记录包含 web.search 和 web.sources；证据在 `.data/langchain-migration/search-check.json`。

网页仍需用户按上表验收。此阶段没有重跑全量 HotpotQA 正确率或真实 DI/Airflow 查询；并未证明所有供应商的非标准 Chat Completions 响应都与旧手写解析器兼容。Python 进程等待审批时继续存活；跨重启恢复仍使用现有 SQLite 检查点和已保存工具证据，而非保存 Python 内存。

后续 Python 迁移顺序：工具注册与执行接口 → 持久化 store/运行协调器 → Gateway 与 HTTP/WS → RAG 与自动化独立入口。每阶段用现有接口行为对照，避免一次切换后丢失审批或恢复能力。
