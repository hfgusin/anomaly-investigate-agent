# Python DI：结构化筛选或只读 SQL 全量导出

新增 DI 查询与 CSV 生成在 `python/di_export.py`；TS 只负责 Agent 调用桥和文件下载，其他模块没有迁移。

## LangChain 工具与失败重试

`python/agent_backend/di_tool.py` 提供两个真正的 LangChain `StructuredTool`：`di_export_table` 负责结构化单表筛选，`di_query_sql` 接收一条只读 Spark SQL。主 Agent 绑定 Python 工具对象；模型请求后仍经过原 Gateway 审批，TS 桥调用同一脚本。两者复用查询编号、分页、完整 CSV 和下载接口。

Python 中可直接调用（项目根目录设置 `PYTHONPATH=python`，或在 `python/` 目录运行）：

```python
import json
from agent_backend.di_tool import di_export_table

# 读取已经完成的本地任务不提交新 SQL。
result = json.loads(di_export_table.invoke({
    "action": "status",
    "query_id": "0f449fb7-37ac-4c20-b0ec-8053a4a2f706",
}))
print(result["state"], result.get("download_url"))
```

直接 Python 调用是本地显式执行；网页 Agent 路径仍要求审批。上述历史任务编号只在当前机器存在，新机器用自己的 query_id。查询请求需要已有 DI 环境配置；原脚本入口会读取 `.env`，直接 import/invoke 不自动加载 `.env`。

`python/agent_backend/di_retry.py` 是自定义 DI 安全重试中间件，作用在底层读取命令，不是 LangChain `create_agent` 的内置 ToolRetryMiddleware，也不对整次导出盲目调用 `.with_retry()`。

| 动作 / 错误 | 处理 |
|---|---|
| session.get / statement.get 的 network 错误、本机读取命令超时 | 最多额外重试 2 次，总计 3 次尝试 |
| 重试间隔 | 1 秒、2 秒；服务端 retry_after_ms 更长时尊重该值 |
| 读取超时 / 重试预算 | 单次 10 秒；每个读取步骤预算 35 秒，无法容纳等待与下一次尝试时停止 |
| execute 提交失败、提交超时或结果未知 | 不自动重试；保留 query_id / 已知 statement_id，用 status 核对 |
| 参数、权限、身份、登录、SQL 错误、确认门禁、主动中断 | 不自动重试、不自动确认、不自动创建 session |

重试次数 `retry_count` 和最近 10 条 `recent_retry_events` 返回给 Agent；完整 `retry_events` 保存在查询 JSON 中。等待超过预算不会变成成功；已知执行编号的网络错误可在后续同一 status 请求继续，SQL 执行失败仍是终态。重试没有新增远端 session，也不停止共享会话。

本地故障注入检查：

```bash
PYTHONPATH=python .venv-di/bin/python -m unittest discover -s python/tests -v
```

11 项检查通过，包括工具参数校验、网络重试、退避、预算、提交未知不重放。另已通过 TS 桥调用真实 StructuredTool 读取本机历史 4070 行已完成记录；本轮没有重新执行真实远端查询或故意破坏 DI 网络。

完整 Node 工程回归 146/146 通过，其中两项新增检查覆盖 Chat Completions / Responses 绑定 Python DI 工具 schema、审批回调与结果回填。真实模型通过内存数据库中的 Coordinator 审批调用 status 后回答“已完成、4070 行”；证据为 `.data/langchain-migration/di-tool-check.json`。该真实检查只读已有本机记录，不提交远端 SQL。

## 在 Agent 中用

重启服务后，可以说：

> 查询 cnfashionbi_scs.scs_ads_roll_out_rab_roas_data，date 是日期字段、site 是站点字段，导出 BRFA 有数据的最新一天，全部匹配记录整理成 CSV。

或：

> 查询这个表的 BRFA，date 从 2026-10-01 到 2026-10-08（不包含结束日期），再筛选 action = pause，导出全部匹配记录。

结构化工具支持字段列表、最多 10 个简单 AND 条件、日期区间和最新一天。两种工具都没有总行数限制，也没有默认 1000 行。等待中的任务继续用同一 query_id 的 status，不重新查询源表。

需要 JOIN、CTE、子查询、CASE、窗口函数或自由聚合时使用 SQL 工具：

```json
{
  "action": "sql",
  "sql": "WITH daily AS (SELECT grass_region, SUM(ads_gmv) AS gmv, SUM(ads_exp) AS spend FROM cnfashionbi_scs.scs_item_growth_performance_by_day WHERE grass_date >= '2026-10-01' AND grass_date < '2026-10-08' GROUP BY grass_region) SELECT *, CASE WHEN spend = 0 THEN NULL ELSE gmv / spend END AS roas FROM daily"
}
```

SQL 最长 7,000 字符且 UTF-8 内容不超过 7,000 字节，只允许一条 `SELECT` 或 `WITH ... SELECT`。写入、DDL、管理命令、多语句、Spark `TRANSFORM` 和 Java 反射调用会在提交 DI 前拒绝。SQL 工具不会自动补日期、站点或 LIMIT；模型生成的完整 SQL 会显示在审批参数中。

**最新一天默认是在已有筛选（例如 BRFA）里取最大业务日期**，不是今天，不是最大入库日期或最新一条时间戳。用 `latest_scope=table` 可改成全表最新日期，再筛指定站点。时间戳转换到日期遵循 Spark session 时区；新查询记录会保留这个时区，不擅自改会话配置。

如果某个站点没有数据，结果为 0 行 CSV（保留表头）；不能报为执行失败。字段 site/region/date/grass_date 等需要按真实表指定，模型不应猜。

## Python 直接用（Pydantic）

依赖安装到独立环境：

```bash
cd /Users/yara.huang/Documents/ui/openclaw-mirror
uv venv .venv-di
uv pip install --python .venv-di/bin/python -r python/requirements.txt
```

编辑 `docs/di-export-request.json` 的表名、站点、日期条件，然后直接运行：

```bash
.venv-di/bin/python python/di_export.py
```

也可以传入自己的 JSON 文件：

```bash
.venv-di/bin/python python/di_export.py < docs/di-export-request.json
```

不再使用 argparse 或 `--table` 等命令行参数。本地入口读取 `.env` 中的 DI 配置，已有环境变量优先；默认等待完成并向 stderr 输出进度。Agent 传入 JSON，并通过内部环境变量 `DI_AGENT_CALL=1` 分段执行，随后用同一个 query_id 继续。

`python/di_models.py` 定义 QueryRequest、RawSQLRequest、StatusRequest 和 Filter；Pydantic 在调用 DI 前校验字段、类型、日期组合、只读 SQL 和未知参数。结构化查询的 SQL 拼接仍保留标识符检查与值转义。错误响应包含字段路径和原因，不回显输入值。

日期区间请求示例（左闭右开）：

```json
{
  "action": "query",
  "table": "cnfashionbi_scs.scs_ads_roll_out_rab_roas_data",
  "date_column": "date",
  "start": "2026-10-01",
  "end": "2026-10-08",
  "filters": [{"column": "site", "operator": "=", "value": "BRFA"}]
}
```

可选 `columns` 字段列表；条件运算支持 `= != > >= < <=`，多个条件用 AND。最新一天请求见示例文件。任务恢复使用 `{"action":"status","query_id":"已有查询 UUID"}`，不用重新发 query。

## 全量取回与完整性

使用现有共享 session 的 PySpark 执行生成的只读 SELECT，不在业务 SQL 中加 LIMIT。将匹配行缓存到 Spark executor 临时磁盘并编号，分批取回本机，再写 CSV。每批的大小仅用于传输，不限制最终总行数。缓存属于 Spark 临时资源，不改业务表；导出正常结束会清理缓存。

CSV 只有在每批连续、没有缺行，并且最终 CSV 行数等于缓存结果总数时，才标记 completed、提供下载。DI 截断输出时尝试缩小传输批次，无法恢复时保留失败原因，不将部分数据伪装成完整导出。

Spark 缓存不等于数据库事务快照；导出期间 executor 丢失导致重新计算可能受源数据变化影响。session 过期会失去缓存，此时不能继续该导出。大结果会占用临时磁盘、产生更多 Spark 批次并耗时，当前未做云存储直出优化。

2026-10-08 实测：复用 session 7137696，BRFA 最新业务日期为 2026-10-07，筛选总数 4070 行、实际 CSV 4070 行，完整性核对通过。查询 ID 为 `0f449fb7-37ac-4c20-b0ec-8053a4a2f706`。TH 条件实测 0 行，仍成功生成带表头 CSV；这不代表能自动识别国家简称和站点代码之间的映射。

每次已确认的 statement ID、总数、已取行数、批次文件和最终 CSV 保存于 `.data/di-exports/`。重启/停止不自动重新提交源 SQL，也不自动停止远端 Spark。已知 statement 可以用 status 继续；提交结果未知且没有 ID 时需核对原 session。

## 本地配置

```dotenv
DI_SESSION_ID=7137696
DI_IDENTITY=yara.huang
DI_QUEUE=cnfashionbi-dev
DI_SESSION_NAME=openclaw-mirror
DI_PYTHON=.venv-di/bin/python
DI_BIN=
```

本地 Python 需要 requirements.txt 中的 Pydantic 2 和 python-dotenv；Spark/PySpark 使用服务器现有环境。DI 必须已经登录。配置的 session 存在时优先复用并校验 owner；`DI_SESSION_ID` 留空或已过期时，只在用户批准 DI 工具后使用 `DI_QUEUE`（默认 `cnfashionbi-dev`）创建 PySpark session。创建中的任务返回 `query_id`，后续用 `status` 继续。

CSV 使用 UTF-8 BOM 和标准 CSV 转义。空值为空单元格、嵌套值为 JSON，疑似公式字符串加单引号。历史限量样例保留原有标记，不当作本次全量结果。

实现参考：[Spark zipWithIndex](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.RDD.zipWithIndex.html)、[Spark persist](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.RDD.persist.html)。实际服务器支持程度以本次运行结果为准。
