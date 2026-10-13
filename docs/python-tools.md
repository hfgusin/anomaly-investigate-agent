# 自己写 Python 工具与 Agent 逻辑

业务工具由 Python 定义、注册和执行。网页模式只把审批、限流、审计和显示交给 TS。

## 先用最小入口看懂 LangChain

在项目根目录运行：

```sh
.venv-di/bin/python python/playground.py
```

它使用 `.env` 的模型配置，第一轮要求调用 `greet_user(name="Yara")`。
这是直接 Python 学习入口，没有网页审批：模型选中的业务工具会实际执行，包括 DI/Airflow。
在 `python/agent_backend/tools/example.py` 的 return 行打断点，查看 name。
完整消息保存在 playground.py 的 messages 中，包括 HumanMessage、AIMessage 和 ToolMessage。

## 添加一个工具

1. 在 `python/agent_backend/tools/` 新建文件，写函数：

```python
from langchain_core.tools import tool

@tool
def check_order(order_id: str) -> str:
    """查询指定订单的状态。"""
    # 在这里调用你自己的 Python 业务代码。
    return f"订单 {order_id} 的查询结果"
```

2. 在 `tools/__init__.py` import 函数并加入 `TOOLS`。
3. 可选：在同文件用 `_describe` 声明元数据：risk（`read`、`network_read`、`write`、`execute`，未声明默认 `execute`）、所属 Skill、审批卡标题、是否自动批准（只对 read / network_read 生效）。
4. 重启服务。TS 启动时执行 `agent_backend.catalog`，从 @tool 生成网页工具目录和参数 schema。无需修改 TS 工具类、TS execute 分支或 TS 风险列表。

`@tool` 生成工具对象；`TOOLS` 是唯一业务工具注册列表。函数名为工具名，docstring 为说明，类型注解生成参数 schema。更复杂的参数可使用 Pydantic args_schema，参考 di_tool.py。
stdout 是网页桥接协议通道；工具中调试时用 IDE 断点，不要 print 到 stdout。

## 在哪里加其他逻辑

- `tools/*.py`：具体业务逻辑、调用自己的模块。
- `agent_backend/agent.py`：标准 `create_agent` 构建；在 `BUSINESS_MIDDLEWARE` 加自己的 LangChain middleware。
- `agent_backend/runtime.py`：网页运行入口、消息历史、模型配置和 Skill 拼接。
- `agent_backend/middleware.py`：网页审批、限流、结果传输；批准后调用 `handler(request)`，由标准 ToolNode 执行 Python 函数。
- `agent_backend/ark_model.py`：现有模型接口适配。

网页执行链：模型选工具 → TS 检查权限并等待批准 → Python handler/ToolNode 执行 @tool → TS 保存真实结果 → 模型继续回答。
拒绝时不会进入 Python 函数。Growth Skill 仍只允许 DI 两个工具；增加业务工具不会绕过 Skill 或 Agent 的工具白名单。

## 网页手动验收

启动/重启：`npm run dev`。使用 `.env` 中的真实模型配置和 `AGENT_ENGINE=langchain`。

普通会话输入：`请调用 greet_user，名字是 Yara`（不要启用 Growth Skill）。

- 批准：应显示 Python 返回的问候；工具记录先等待审批，再执行并完成。
- 拒绝：不执行函数；在 Python 函数断点处不应停住。
- 把 example.py 的返回文案改一下，重启再调用，应得到新文案。

`.vscode/launch.json` 也提供“Python：工具 Playground”，便于直接 F5 看函数和消息历史。

## 现有边界

DI、Airflow、示例与后续自定义业务工具走 Python。工作区文件操作、公共网页读取、研究任务、委派仍是 TS 平台工具，由显式 Gateway 适配提供。旧 `AGENT_ENGINE=native` 和 Airflow 看板/独立检查入口仍保留其 TS 实现；新 Python 业务工具入口针对 LangChain 引擎。

Airflow 认证：配置 `AIRFLOW_USERNAME` 和 `AIRFLOW_PASSWORD` 后，API 认证失败或返回登录页时会自动获取 CSRF、登录网页，再用同一个会话重试原查询一次。`AIRFLOW_TOKEN` 设置时优先 Bearer；有效的 `AIRFLOW_COOKIE` 仍可直接使用。登录是客户端认证逻辑，不作为模型工具注册。
