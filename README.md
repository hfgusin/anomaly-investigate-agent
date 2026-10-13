# auto-troubleshoot-agent

# OpenClaw Mirror

以 OpenClaw 2026.9.6 为目标、逐模块独立实现的本地 Agent 项目。当前有 Gateway、持久化会话和 HotpotQA 多跳资料研究的第一版；尚未达到 OpenClaw 的功能或协议兼容。当前完成度、缺口和后续顺序见 [P0～P13 总路线图](docs/roadmap.md)；原版实测观察见 [P0 对照](docs/parity.md)。

## 启动

主 Agent 模型与工具循环已接入 **Python LangChain**；Gateway、网页、审批与 SQLite 暂时沿用现有实现。当前机器依赖已安装，重启即可使用。代码路径、Python 环境安装和页面验收见 [Python / LangChain 迁移](docs/python-langchain.md)。若看不懂 `src/` 里的 TypeScript，可看 [src 与 Python 对照说明](docs/src-Python可读对照.md)，并对照 `python/mirror_read/`（模型循环在 `python/agent_backend/runtime.py`）。

广告投放 RAG：全 TypeScript 实现，`pnpm rag:prepare` 下载清洗，`pnpm rag:index` 使用本地 MiniLM ONNX 向量化，`pnpm rag:search "你的问题"` 检索后通过已配置模型生成中文回答、证据翻译与出处。加 `--raw` 仅本地检索，无需模型 Key。新环境先 `pnpm install`，再执行 `pnpm rag:setup` 下载固定模型；向量化与检索本身离线运行，中文回答需要模型接口。结果与人工检查方法见 [广告语料说明](docs/ads-rag.md)。当前检索为独立入口，尚未接入网页 Agent。

Airflow DAG、运行、任务状态和日志查询：见 [Airflow 配置与手动验收](docs/airflow.md)。认证凭据只填写在本地 `.env`。

工程稳定性验收：`pnpm verify --repeat 2`。Web 顶部「验收报告」可查看逐轮结果、故障 Trace 与限流状态。配置与验收边界见 [稳定性说明](docs/stability.md)。

环境：Node.js 22.13+、pnpm 11。当前开发环境为 Node.js 22.22.3、pnpm 11.19.0。

```sh
pnpm install
pnpm dev
```

浏览器打开 <http://127.0.0.1:18789>。服务固定监听本机回环地址；不支持公网部署。已有其他服务占用端口时，在 `.env` 修改 `PORT`。服务退出后用 `pnpm start` 启动编译后的版本；修改 TypeScript 后用 `pnpm dev` 重新编译启动。

同一个 Gateway 也可从终端操作：

```sh
pnpm mirror sessions
pnpm mirror create
pnpm mirror send <会话 ID> "你好"
pnpm mirror inspect <Run ID>
```

CLI 和 Web 读取同一批会话及 Run。`pnpm mirror --help` 列出新建子会话、重置、停止与工具审批命令。交互式发送遇到工具请求会询问是否允许；非交互式发送返回待审批 Run 与明确的 `approve`/`deny` 命令，不自动批准。默认连 `ws://127.0.0.1:18789/gateway`；若改了端口，设置 `MIRROR_GATEWAY_URL=ws://127.0.0.1:<端口>/gateway`。CLI 目前只允许连接本机。

## 多 Agent 协作

输入 `/team` 启动父 Agent，例如：

```text
/team 派发两个 reader：一个读取 agent_demo.txt，另一个列出工作区文件；完成后汇总并引用子任务。
```

父任务先请求派发审批，孩子的工具也分别审批。页面显示子任务卡片、停止按钮及独立 Trace；支持一层只读子任务的排队、回传和重启恢复。左下角「Agent 配置」查看角色，`config/agents.json` 修改配置。完整原理、真实模型结果和用户验收步骤见 [Multi-Agent 说明](docs/multi-agent.md)。

## 方舟 Responses 内置联网搜索

当前已接入 Responses 适配器。`.env` 设置：

```dotenv
MIRROR_RUNTIME=responses
MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
MODEL_NAME=deepseek-v4-1-flash-260910
MODEL_API_KEY=你的新密钥
RESPONSES_WEB_SEARCH=true
RESPONSES_MAX_KEYWORD=3
```

程序调用 `/responses`，使用 `input`、流式输出和内置 `web_search`。普通聊天可自动搜索；页面显示实际查询与服务商返回的可点击网页引用。搜索由方舟服务端自动执行，不经过本地逐次审批。文件函数调用仍保留审批。研究 Skill 和 Agent 角色保留原工具范围，不提供内置搜索；摘要也关闭搜索。

`max_keyword` 控制并行搜索关键词数，不是总搜索次数或费用硬上限。可设置 `RESPONSES_WEB_SEARCH=false` 关闭内置搜索；可选 `MODEL_THINKING=disabled`，仅在所用模型支持时设置。新模型和真实联网尚待用新密钥端到端验证，当前工程回归使用受控响应。操作与边界见 [Responses 接入](docs/responses.md)。

## 接入已有的 OpenAI 兼容接口

将 `.env.example` 复制为 `.env`，填写：

```dotenv
MIRROR_RUNTIME=chat-completions
MODEL_BASE_URL=你的API根地址
MODEL_NAME=你的模型ID
MODEL_API_KEY=你的密钥
# 当前接口若无法处理标准 tool 消息，可设置：
MODEL_TOOL_RESULT_MODE=plain
# 单次模型请求的上下文预算，单位为字符，默认 120000
CONTEXT_BUDGET_CHARS=120000
```

Base URL 需包含服务商要求的路径（如 `/v1`），程序追加 `/chat/completions`。本版支持 Chat Completions 的流式文本和工具调用，也能解析服务商返回的完整 JSON；多模态尚未实现。接口错误会明确失败，不会自动切换回演示模式。密钥仅从本地环境读取，`.env` 已加入忽略清单。

默认 `MIRROR_RUNTIME=demo` 只显示演示回声，不调用任何外部 API。当前本机已设置为真实模型模式，并完成一次普通文本回答和一次 `read_file` 后继续回答的浏览器验证。

密钥只放在本地 `.env`，不要发到聊天里。`MODEL_TOOL_RESULT_MODE=standard` 使用规范的 `assistant tool_calls` 与 `tool` 消息，支持最多 8 轮工具调用；此前的 `compass-max` 接口在标准工具结果消息后多次返回 HTTP 200 空响应，因此当时设置为 `plain`：将已执行工具的结果标明来源、作为数据附在用户请求后再发给模型。这个兼容模式每次运行只允许一轮工具调用，不代表原版 OpenClaw 的协议行为。新模型 `doubao-seed-2-0-mini-260428` 已通过 3 题的一轮标准工具结果试跑，后续 `/research2` 和 `/team` 已有标准多轮真实运行记录，但研究质量尚未稳定；这两个入口显式使用标准模式，普通聊天本机配置现已在真实两轮随机代号检查通过后切为 `standard`，重启服务生效。

## 工作区读取工具

普通对话可以调用 `read_file(path)` 读取文本、`search_workspace(query)` 搜索文本、`list_workspace(directory)` 列目录。它们只访问本项目的 `workspace/`：读取单文件上限 64 KiB，搜索最多遍历四层、100 个文件，返回最多 20 条短片段；隐藏文件、路径上跳和符号链接会被拒绝。工具请求、参数、结果和终态写入对应运行的记录，浏览器展开「运行记录」即可查看。

普通对话还提供三类需要逐次审批的能力：

- `write_file(path, content, mode)`：在 `workspace/` 创建文本文件；替换已有文件需要先用 `read_file` 得到 SHA-256，再把它作为 `expected_sha256` 传入，内容变化会拒绝替换。单次最多写入 6 KiB。已执行的写入不会在 Gateway 重启后自动重放。
- `fetch_url(url)`：读取公共 HTTPS 网页，检查解析地址并拒绝本机/内网，限制重定向、时间、响应量和返回文本长度。网页内容只作为资料，不作为指令；当前开发终端的公共 DNS 不可用，尚未在真实公网网页上完成验证。
- `run_javascript(code)`：默认关闭，不向模型提供，模型强行请求也会被策略阻止。只有明确设置 `MIRROR_ENABLE_CODE=true` 才能用于可信本地实验；此时仍需逐次审批，一次最多一个子进程，10 秒时限、64 MiB V8 堆上限、最多 16 KiB 输出，不继承模型 API Key。这些限制不等于操作系统内存隔离，也没有网络出口隔离，因此不作为安全沙箱使用。

把愿意让所选模型读取或修改的文本放进 `workspace/`。该目录中的用户文件默认被 Git 忽略。`/research`、`/research2` 则使用各自的 HotpotQA 研究工具。单次运行最多 16 次工具调用；每次请求均经过 Web 或 CLI 审批。当前本机配置若为 `MODEL_TOOL_RESULT_MODE=plain`，普通对话每次运行只能完成一轮工具调用；连续“先读再改”等任务需使用可处理标准工具结果的模型和 `standard` 模式。

写入以暂存文件提交，创建不会覆盖已有文件；同一 Gateway 内同一路径不能并发写入。工具成功结果先保存再处理取消。写入或代码执行已启动但结果未落库时，重启/停止会标记为 `unknown`（结果待核对），不自动重试；发生不确定执行结果会终止本次模型循环。已开始产生副作用的运行不能用“引导”重新生成。安全边界、故障用例和待完成项见[安全记录](docs/security.md)。

目录中已放入不含业务数据的 `agent_demo.txt`。本机已实际提问「调用 `read_file` 读取 `agent_demo.txt`，仅根据文件内容回答项目代号」，最终回答 `Cedar-731`，运行记录显示一次成功的 `read_file` 调用及文件内容。此前标准工具结果模式出现的失败运行保留在本机数据库中，可用于比较和复盘。

## Skill 发现与刷新

新增 `skills/<名称>/SKILL.md` 后，通过 `/<名称> 任务` 使用；`.data/skills/` 同名覆盖项目版本。新任务执行时自动刷新，已开始的 Run 使用 SQLite 中保存的内容快照。页面左下角 **Skills** 查看来源、版本和刷新错误。首次部署代码需要重启，之后改 Skill 无需重启。规则与手动验收见 [Skills](docs/skills.md)。

## 多跳资料研究

发送 `/research <HotpotQA 原题>` 会激活 `multi-hop-research` Skill，调用独立 Worker 中的 `research_hotpot`。工具对每题的 10 篇 distractor 候选文章做两跳检索，返回带句子编号的证据；模型负责形成答案和引用。工具返回中没有标准答案或标准支持事实。完整 validation 数据及许可见[数据来源](data/hotpotqa/README.md)，检索覆盖、真实模型失败案例和页面验收步骤见[评测记录](docs/hotpotqa-evaluation.md)。

实验入口 `/research2 <HotpotQA 原题>` 使用 `search_passages` 和 `open_passage` 分步研究：搜索只返回五篇候选标题与短片段，打开文章才返回可引用句子。每个 Run 最多搜索两次、打开四篇；两篇出处不齐时最多给模型一次具体校验反馈并允许继续在限额内调用工具。此入口强制使用标准工具结果协议，不依赖 `.env` 的全局工具回填配置。真实 Gateway 已跑通逐步工具审批与回答，固定 10 题早期 CLI 初稿联合精确匹配为 1/10；后续真实 Gateway 配对评测为完成 9/10、联合精确匹配 2/10，旧入口联合精确匹配为 3/10，因此仍是实验入口。详见[第二版计划和当前结果](docs/next-milestone.md)。

长任务运行（总路线图 P2） 已为 `/research2` 增加 SQLite 步骤事件和检查点：Gateway 意外重启后，已保存的只读工具结果复用，未保存的只读步骤按原审批状态继续；待审批调用仍需手动决定。重启前的部分模型输出保存在运行尝试记录中，新模型请求从检查点重建。故障注入和真实模型重启验证见[长任务运行记录](docs/long-running-agent.md)。

Web 工作台（总路线图 P11）的任务详情已加入「任务详情」：在每条运行旁点击按钮，可查看当前检查点、按序步骤、重启前草稿与恢复次数，以及本次研究工具实际打开过的文章句子；待审批工具也可直接在面板中允许或拒绝。出处显示为 HotpotQA 文章标题和句子编号，没有外部链接。页面只读取本机 Gateway 的运行记录，不调用标准答案。

Web 工作台（总路线图 P11）的评测视图是页头「评测」：读取本机 `.data/hotpotqa/gateway-paired-2026-09-30.json`，展示固定 10 题的 `/research` 与 `/research2` 对照。点开一题可看原题、标准答案、支持事实、两份模型输出、失败原因及保存的工具轨迹。原题和标准答案只有在当前 HotpotQA 数据集的 SHA-256 与报告记录一致时才显示；页面不会重新调用模型。该历史评测的临时 Run 数据库已清理，因此报告里的工具轨迹可查，但不能跳回原 Run。

## 已完成的行为

- 会话、输入、部分输出、运行状态写入本机 SQLite。
- 同一会话逐条执行，不同会话可独立执行；每会话最多 8 个待处理任务，全局最多 32 个。
- 在运行开始时组装上下文，排队的第二轮能读到第一轮完整回答，也不会读到后续请求。
- 上下文按完整对话轮次从新到旧纳入预算；当前问题和引导始终保留，超出 `CONTEXT_BUDGET_CHARS` 时裁掉最旧完整轮次。每次实际使用量和裁剪数量持久化到运行记录。
- 被裁掉的连续历史生成带来源 Run ID 的原文摘录快照；真实模型可生成固定小节的短摘要。摘要通过来源和长度检查后用于本次及后续回答；失败时使用原文摘录。运行记录显示状态和快照 ID。
- 相同会话与 `clientRequestId` 的重复请求返回原运行，不重复调用模型；内容冲突明确拒绝。
- 可停止排队和运行中的任务；取消、超时和模型异常保留已有输出。
- 回答生成中发送新消息时，页面切换为「引导当前运行」：新内容保存到当前 Run，当前模型流取消后以原问题和引导重新生成，不创建普通排队任务。相同请求编号重发不会重复注入。
- 进程退出后重新启动，普通未完成任务标为 `interrupted`；`/research2` 和持久化 Agent 任务按检查点恢复，复用已落库结果。恢复会重新发起模型请求，可能产生额外费用，不是原网络流续传。
- 浏览器断线后读取持久化快照；切换会话按会话 ID 和重置代数筛选数据；较旧的历史响应不能覆盖较新的流式内容。
- 新建会话；`/new` 在当前会话下创建子会话并保留父会话；`/reset` 在原会话清除上下文且保留标题。忙碌会话拒绝重置，防止旧运行写入新上下文。
- 浏览器可查看每次运行的 ID、状态和时间。
- 模型可以请求工作区文件和网页读取工具；短代码执行默认关闭，显式开启后才提供。每次调用记录持久化，审批和执行后模型可以继续生成回答。

SQLite 位于 `.data/gateway.sqlite`。一个数据目录只允许一个 Gateway 进程使用；独立 SQLite 锁库随进程死亡自动释放。Node 22 的 `node:sqlite` 仍标为实验性 API，会打印相关提示。当前使用同步 SQLite、逐块持久化和完整运行快照，尚未做大规模吞吐与延迟评测。

## 代码入口

```text
src/server.ts                     本机 HTTP / WebSocket 入口、Origin 校验、关闭流程
src/gateway.ts                    请求校验、会话路由、事件广播
src/run-coordinator.ts            排队、幂等、取消、超时、上下文组装时机
src/session-store.ts              SQLite 事务、会话代数、运行状态、进程锁
src/runtime.ts                    Runtime 接口与显式演示模式
src/providers/chat-completions.ts 流式模型适配器、SSE 解码、异常结束处理
src/tools/read-file.ts            只读文件工具、工作区边界、工具定义
src/tools/research-hotpot.ts      HotpotQA 两跳检索
src/tools/research-worker-client.ts 工具超时、重复响应和 Worker 重启
src/skills.ts                     研究 Skill 选择
public/app.js                     会话界面、重连、运行状态
public/client-state.js            运行版本合并与会话筛选
scripts/mirror-cli.mjs             通过同一 Gateway 操作会话、Run 与工具审批
```

一起读代码从 [请求的实际调用链](docs/walkthrough.md) 开始。

## 验证

```sh
pnpm test
```

自动检查包括 SQLite 重开与旧库迁移、真正 SIGKILL 后新进程恢复、`/new` 和 `/reset`、逐会话队列、跨会话执行、重复请求、运行中引导与幂等重发、工具允许/拒绝、取消、超时、上下文预算裁剪、Memory 回退与重启恢复、工具结果空间限制、WebSocket、模型流异常、工作区边界，以及 HotpotQA Worker 的超时、重复事件和崩溃重启。自动检查使用可控测试实现，不调用付费接口。

真实接口的 Memory 检查可运行 `node scripts/qa-memory-live.mjs`：它在临时 SQLite 中放入随机项目代号和超预算填充历史，触发摘要，再让配置的模型回答代号。脚本逐项检查摘要状态、事实来源 Run ID、上下文预算和精确回答，测试结束后清理临时目录。当前修复后连续 3 次通过这一简单场景；测试范围与未证明的能力见[Memory 评测](docs/memory-evaluation.md)。

进一步运行 `node scripts/qa-memory-cases.mjs` 可检查事实更新、助手纠错、待分析文本、两个较晚事实和未标记旧指令。脚本把摘要成功与摘要失败后回退分别报告；最终答对不能代替摘要质量结论。

浏览器实际检查了：发消息、生成中切换会话、停止后保留部分输出、刷新后恢复会话与停止状态；真实接口下普通文本回答、两轮标记、`read_file` 后继续回答、`search_workspace` 的命中/空结果/拒绝路径。另在原版 OpenClaw 2026.9.6 和 Mirror 上使用同一本地模型桩对照了 P0-1 至 P0-7；具体观察点和差异见[复刻清单](docs/parity.md)。单次成功不证明长期稳定性或完整一致性。

## 后续复刻范围

统一按 [P0～P13 总路线图](docs/roadmap.md) 推进：Skills 发现与刷新第一版已实现，下一步做自动化和一个外部消息渠道；原版 Gateway 协议兼容单独对照验收。鉴权与会话权限继续按用户要求延期，完整 P1 验收仍受此项限制。

跨会话长期 Memory、普通任务中写入与代码执行的安全续跑、WebSocket 事件重放、插件/MCP、远程节点和完整 OpenClaw 客户端兼容仍未完成；页面也还未完成原版视觉对照。

## Python 工具开发

业务工具使用 Python `@tool`，在 `python/agent_backend/tools/__init__.py` 的 `TOOLS` 注册。学习入口：`.venv-di/bin/python python/playground.py`。参见 [工具开发与手动验收](docs/python-tools.md)。
