# Airflow 只读 API 工具

实现：`python/agent_backend/tools/airflow.py`。Agent 和自动化看板用的是同一份代码。

## 配置

在项目 `.env` 填写（凭据只放本地，不发到聊天里）：

```dotenv
AIRFLOW_BASE_URL=http://35.247.161.180:8080
AIRFLOW_USERNAME=你的登录名
AIRFLOW_PASSWORD=你的密码
# 或者：AIRFLOW_TOKEN=...（填了就用 Bearer，忽略账号密码）
# 可选：AIRFLOW_COOKIE=session=...（API 只认网页会话时使用）
```

广告自动化（`scs_take_rate_ads` 等）在另一台 Airflow 上，单独配置。工具传 `server: "automation"` 时用这一组（看板固定用它，Agent 由模型按 DAG 选择）：

```dotenv
AUTOMATION_AIRFLOW_BASE_URL=http://34.142.225.103:8080
AUTOMATION_AIRFLOW_COOKIE=session=...
```

这台服务的 API 不接受 Basic 认证（返回 401），只认网页登录后的 `session` cookie。cookie 过期后看板的 Airflow 部分会刷新失败，此时从浏览器开发者工具复制新的 `session` 值替换即可。

修改 `.env` 后重启 `pnpm dev`。

## 工具

每种查询一个工具，参数说明写在函数 docstring 里，模型直接看到：

| 工具 | 用途 |
|------|------|
| `airflow_list_dags` | 列出 DAG（分页） |
| `airflow_get_dag` | 单个 DAG 的配置 |
| `airflow_list_runs` | 某 DAG 的运行记录，最新在前（分页） |
| `airflow_get_run` | 一次运行的状态与起止时间 |
| `airflow_list_tasks` | 一次运行内所有任务实例的状态（分页） |
| `airflow_get_task` | 单个任务实例，含 `try_number` |
| `airflow_get_task_log` | 某次尝试的日志，只返回末尾 12000 字符 |

列表结果带 `total_entries` 和 `next_offset`，`next_offset` 不为空就说明还有下一页。

出错时（认证失败、404、超时、连不上）工具抛 `ToolException`，错误文字作为工具结果返回给模型，不会中断整个回答。

## 手动验收

### 直接调用（不经过模型和审批）

```sh
pnpm airflow:check            # 等于下面的 airflow_list_dags {"limit": 10}

cd python
../.venv-di/bin/python -m agent_backend.airflow_cli airflow_list_runs '{"dag_id": "your_dag", "limit": 5}'
../.venv-di/bin/python -m agent_backend.airflow_cli airflow_get_task_log '{"dag_id": "d", "dag_run_id": "r", "task_id": "t", "try_number": 1}'
```

命令行会自动读取项目 `.env`；已经在终端 export 的同名变量优先。成功打印 JSON，失败把错误打到 stderr 并返回非零退出码。

### 通过 Agent

1. 「列出前 10 个 DAG，给我 DAG ID 和暂停状态」：应出现 `airflow_list_dags` 审批。
2. 「查询 DAG `<dag_id>` 最近 5 次运行」：`airflow_list_runs`。
3. 「查询运行 `<dag_run_id>` 的任务状态，找出失败任务」：`airflow_list_tasks`。
4. 「读取该失败任务最近一次尝试的日志，解释失败原因」：先 `airflow_get_task` 拿 `try_number`，再 `airflow_get_task_log`。

## 边界

- 只发 GET；服务地址和凭据来自环境变量，模型只能在 `default` / `automation` 两台之间选。
- 只支持 Airflow 2 的 `/api/v1`。
- 请求超时 10 秒；日志只保留末尾 12000 字符。
- 返回选定字段，不回传运行 `conf`。日志原样返回，不做脱敏。
