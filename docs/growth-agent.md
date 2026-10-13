# 商品成长分析 Agent（第一版）

## 使用

重启项目后，点击左侧 **商品成长分析**，直接输入中文问题，不需要 `/growth` 前缀。

可问：

- 查 TH 最新一天各成长阶段的订单、GMV、广告花费和整体 ROAS。
- 查 TH 2026-10-01 至 2026-10-07 的每日 GMV、广告花费和 ROAS（结束日期不包含在内）。
- 按 TH 最新一天的 group_type 比较 GMV、订单和广告花费。
- 查 THGO 最新一天预算调整日志，各 operate 的记录数。

工具审批页会显示表、时间、站点、分组和聚合参数。允许后才调用 DI；拒绝后不执行。工具结果有真实数据预览、SQL、查询编号和完整 CSV。

等待中的导出使用原 query_id 的 status 继续，不重新提交 query。最多 20 行、10000 字符的预览，截断会标记；CSV 没有总行数限制。分组聚合在 Spark 中执行，预览是聚合结果行，不是把前 20 条原始数据当作统计。

## DI session（2026-10-08）

`.env` 的历史 DI_SESSION_ID=7137696 在 sg 已返回 HTTP 404。现在工具会优先复用并核对已有 session；编号留空或已过期时，在用户批准该次 DI 调用后使用 `DI_QUEUE`（默认 `cnfashionbi-dev`）创建新的 PySpark session。Diana 浏览器登录与 DI Spark 会话仍是两条链路。

## 数据与口径

来源：Diana [商品成长与广告投放分析](https://datasuite.shopee.io/diana2/topic/15496)，2026-10-08 核对了页面的六张表、日期列、指标、维度与 TH 命名规则。字段清单在 `data/topics/growth.json`，Python 校验和网页共用这一份。

- 日趋势：scs_item_growth_performance_by_day，grass_date、grass_region。
- 成长周期汇总：scs_item_growth_performance，grow_start_date。不是单日指标。
- TH 每日表现用 TH；调度、预算调整/创建日志的已确认映射用 THGO。
- 整体 ROAS = SUM(ads_gmv)/SUM(ads_exp)，分母零为 NULL；平均单行 ROAS 是另一种口径。
- 操作日志 count 是记录数，不是去重商品数；日志预算之和不是当前有效预算。
- 单商品 item_id 等字段尚未在逐表 schema 中核实，第一版不猜字段。因此当前支持成长阶段、站点、类目、实验分组分析，尚不支持单商品跨表生命周期追踪。
- 实验分组比较只给观察性差异，不证明因果增量。尚无跨表 JOIN、最新操作去重或完整 Diana 功能。

## 实现链路

网页创建 topicId=growth 的会话 → SQLite 保存主题 → Coordinator 自动选 growth Skill、注入字段/口径 → Python LangChain 模型输出 StructuredTool 参数 → Gateway 等待审批 → Python Pydantic 校验主题表/字段/日期 → 安全 DSL 编译 SELECT/GROUP BY → 已有 DI session 执行 → 数据批次/CSV/preview → 模型中文解释。

主题会话只提供 DI 工具，关闭模型内置联网；服务端强制 topic_id，status 查询也核对主题，模型不能靠省略参数查询主题外的缓存结果。普通会话仍保持原工具集。重置与 /new 保留主题。

聚合工具支持 count、count_distinct、sum、avg、ratio_sums；不接受任意 SQL。数值聚合显式 CAST AS DOUBLE。相对日期以受理时间的上海日期计算，默认过去 N 个完整自然日，不含今天，并要求说明实际日期区间。

## 验收情况

- TypeScript 编译通过。
- 最终 Node 回归 148 项通过（原 146 项 + 新主题路由/工具隔离 2 项）。Python 16 项通过（新主题/SQL/预览 5 项 + 原 DI 工具 11 项）。
- 用 `.env` 的实际模型在隔离网页输入第一个示例，生成正确日表、TH 过滤、latest_day、成长阶段分组及 ratio_sums。手动拒绝后模型如实回答“未执行”，没有数字或伪造下载链接。
- 实际模型参数在 `.data/growth/model-query.json`，通过 Pydantic 校验并生成 `.data/growth/model-query.sql`；页面截图 `.data/growth/ui.png`。这些是查询规划与界面证据，不是生产数据结果。
- 生产成长查询、字段实际类型、真实聚合数值和 CSV 未通过线上验收，原因是无可用 DI 会话。没有用 fixture 数字冒充生产结果。

## 你可以参与的验收

1. 重启后打开原本的 18789 网页，点击商品成长分析，确认出现六张表及口径说明。
2. 输入第一个示例，查看审批中的日表、TH、growing_period 和 ROAS 分子分母。
3. 有可用 session 后允许执行；等待时继续同一 query_id。
4. 查看实际 latest_day、预览、SQL、完整性标记，下载 CSV，与 DI 查询结果核对。
5. 输入“查 item_id=xxx”，应说明商品字段尚未核实，不能猜字段。
6. 切换普通会话，确认普通工具与联网能力仍可用。
