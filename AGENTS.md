# AGENTS.md

本文件是给编码 Agent 的工作说明。动手前先读完。

## 这个项目是什么

本地 Agent 工作台。TS Gateway 负责网页、会话、审批和 SQLite 存储，Agent 本体用 Python LangChain 实现，两者通过 stdio 逐行 JSON 通信。

| 位置 | 内容 |
|---|---|
| `src/` | TS Gateway。`run-coordinator.ts` 调度运行与审批，`session-store.ts` 管 SQLite，`server.ts` 是 HTTP 入口 |
| `python/agent_backend/` | LangChain Agent：`runtime.py` 流式循环，`middleware.py` 审批与限流，`ark_model.py` 方舟 Responses 模型 |
| `python/agent_backend/tools/` | 业务工具。`__init__.py` 是唯一注册入口，用 `_describe` 声明风险等级、所属 Skill、审批文案 |
| `skills/<name>/SKILL.md` | Skill 指令，每份最多 8000 字符 |
| `public/` | 网页前端，原生 JS，没有构建步骤 |
| `docs/` | 设计文档；改了行为要同步更新对应文档 |

Python 和 TS 之间的协议：Python 发 `model_request`、`tool_call`、`text`、`done` 等事件，TS 回 `model_allowed`、`tool_approval`、`tool_result`。**Python 的 stdout 是协议通道，任何调试输出都只能写到 stderr。**

## 命令

```bash
# Python 测试（没有装 pytest）
cd python && ../.venv-di/bin/python -m unittest discover -s tests

# TS 构建与测试（沙箱里可能没有 pnpm，用 npx）
npx tsc -p . && node --test tests/*.test.mjs
```

- 已知问题：`test_growth.py` 有 5 个断言失败，原因是用户有意注释掉了 `di_models.py` 里的范围校验。不要为了让测试变绿而恢复这段校验。
- 访问 Airflow、DI、GSheet 需要公司网络和本地 `.env`。

## 红线

1. 凭据只存在于本地 `.env` 和凭据文件中。不打印、不写进代码、日志、测试和文档。`/Users/yara.huang/yara/yara/ads/*_local.py` 里有明文凭据，不要引用或复述其中内容。
2. daily-check 只读：不修改业务源码、Data API 和广告配置，不重跑或清除 Airflow 任务。
3. 写操作（写文件、写 GSheet、执行代码）必须经过网页审批，不要绕过。

## 写代码的标准

### 唯一的原则

写最少的代码，让下一个读的人最省力。

读代码的时间远多于写代码的时间。多出来的每一行，无论是多一层防御、多一个字段、还是多一句注释，读的人都要花精力去判断"这是干什么的、能不能删"。说不出存在理由的代码就不该存在。

检验标准：这段代码放进项目里，一个熟悉项目的同事读完，不会问"这里为什么要这样"。

### 由此推出的五条

**1. 只处理真实会发生的情况。** 外部服务的已知失败要处理，想象出来的失败不处理。出错时直接抛 `ToolException`，由 `handle_tool_error` 把错误交回模型。

> 反例（已删除）：Airflow 扫描同时做了请求预算、重复页检测、缺少 total 时的兜底、对已过滤的时间再过滤一次，还返回 `complete` 和 `query_errors` 让调用方去猜结果全不全，共 120 行。
> 正例：两次分页请求，出错直接抛异常，50 行，行为更可预测。见 `tools/airflow_scan.py`。

**2. 返回值只放调用方会用的东西。** 模型每次都要读完工具返回值，无用字段就是噪音。

> 反例（已删除）：`"historical_definition_verified": False`，一个永远为 False 的字段；每次返回都附一大段免责 `note`。
> 正例：这类限制在 Skill 或文档里写一次。

**3. 注释只写代码表达不了的约束。**

> 反例：`# 读取配置`（下一行就是读取配置）；`# 修复：之前这里会报错`（写给审阅者的话，合并后就成了噪音）。
> 正例：`# Run ID 含 ":" 和 "+"，所以每段路径都要编码。` 删掉它，后来的人很可能把编码"优化"掉。

不留调试用的 `print`，不留注释掉的代码。Docstring 写给模型看：一句话说明做什么，再列 Args，不写禁令清单。

**4. 结构让人一眼看懂。**

```python
# 反例
mode = "bearer" if env("TOKEN") else "cookie" if env("COOKIE") else "username_password" if env("USERNAME") and env("PASSWORD") else "not_configured"

# 正例
def _auth_mode(prefix):
    if env("TOKEN"):
        return "bearer"
    if env("COOKIE"):
        return "cookie"
    ...
```

函数只做一件事；嵌套超过两层时，用 early return 或拆分。只用一次的逻辑不抽 helper，同样的逻辑第三次出现时再抽。

**5. 同一件事只在一个地方定义。** 路径放在 `agent_backend/paths.py`；工具元数据写在 `tools/__init__.py` 的 `_describe`，TS 从 catalog 读取，不再按工具名硬编码。

### 跟随现有代码

- 改一个文件前，先读它和相邻文件；命名、注释密度、错误处理方式跟着现有代码走。
- 优先用框架自带的机制（LangChain 的 `@tool`、`ToolNode`、`AgentMiddleware`，pydantic 校验），不自己重造。
- 测试只测行为。外部服务用 `httpx.MockTransport` 或 fixture 模拟。删除功能时一并删除对应测试。

## 工作方式

1. **先理解再动手。** 需求不清楚就提问，不要猜。涉及多个文件的改动，先列出计划。
2. **只改需求要求的部分。** 不顺手重构，不加"以后可能用到"的参数。看到别处有问题，在汇报里提出，不擅自修改。
3. **交付前自查。** 把自己的 diff 当成别人写的从头读一遍，逐行问：删掉它会坏吗？不会坏，就删掉。
4. **验证。** 跑相关测试；能真实调用的接口就真实调用一次。没有验证过的部分，汇报时明说。
5. **汇报用中文。** 第一句说结果，然后说改了什么、为什么这样改、验证了什么、还剩什么没做。用户是新手，术语第一次出现时用一句话解释清楚。
