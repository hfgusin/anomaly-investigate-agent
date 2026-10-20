# 业务质量评测

案例里的表名、路径、商品号、日志和操作记录全部是为评测编写的虚构数据，不包含内部凭据或真实业务记录。

## 两种模式

| 模式 | 数据 | 测什么 |
|---|---|---|
| evidence | `cases.json` + `gold.json`，12 例 | 证据已给定，只测判断：结论、事实归因、不编造 |
| tools | `worlds/W*.json`，5 例 | Agent 按 daily-check Skill 自己调用工具取证：扫描 → 日志 → 源码 → Data API / DI / GSheet → 报告 |

```bash
cd python
../.venv-di/bin/python -m evaluation.run_agent evidence --repeat 3 --concurrency 4
../.venv-di/bin/python -m evaluation.run_agent tools
../.venv-di/bin/python -m evaluation.run_router eval
```

结果摘要写到 `results/`，完整记录（回答、工具调用、逐条评分）写到 `.data/evaluation/`。

## 指标

- **任务成功率**：结论类型正确，`required_facts` 全部覆盖，且没有出现 `forbidden_claims`。
- **幻觉率**：评分模型把回答拆成事实断言，逐条对照证据（evidence 模式是给定证据，tools 模式是本次实际返回的工具结果），统计无证据或与证据矛盾的断言占比。标为假设、待验证的内容不计入。
- 完成率、平均工具调用和模型调用次数、耗时 p50 / p95、token。

评分模型默认 `deepseek-v4-pro-ga-260813`，用 `JUDGE_MODEL_NAME` 覆盖；它与被测 Agent 不是同一个模型。gold 只给评分模型，不给被测 Agent。

## 虚构环境（world）

`python/agent_backend/demo_world.py` 在网络和子进程边界替换外部服务，工具代码不变：

| 字段 | 替换的服务 |
|---|---|
| `airflow` | Airflow REST：`dags`、`task_instances`、`logs`（键为 `dag/run/task/try`）；`"status": 401` 让所有请求失败 |
| `sources` | 服务器路径 → 源码内容，`read_project_source` 读取 |
| `data_apis` | `名称@版本` → `{status, code}`，Data API CLI 返回 |
| `di_queries` | 每项 `match` 是一组正则，SQL 全部匹配时返回 `columns` / `rows`，否则查询失败 |
| `gsheets` | tab 名 → 行 |

留底工具写到临时数据库，不同步真实 GSheet。

离线演示：启动前设置 `MIRROR_DEMO_WORLD=<world 文件绝对路径>`，网页里的 Agent 和每日扫描都只访问这个虚构环境，不需要公司网络。

## 意图路由

`router/test.json` 是 40 条测试句（四类各 10 条），`router/pool.json` 是 40 条不重叠的候选句。流程：

1. `run_router label`：大模型标注候选池，写入 `config/router-examples.json`。
2. 人工复核这份示例（本次改了 1 条），再作为小模型的 few-shot 示例。
3. `run_router eval`：在测试集上对比关键词规则、小模型零样本、小模型 + 示例、大模型零样本。

## 局限

- 案例少（12 + 5 + 40），只能发现明显问题，不能给出有统计意义的结论。
- 测试句和 world 由开发者编写，评分模型本身也会出错；有争议的结果要读 `.data/evaluation/` 里的完整记录人工确认。
- 这些案例都参与过调试，不能当最终封存集。
