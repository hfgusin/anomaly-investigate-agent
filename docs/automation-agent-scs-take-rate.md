# 首个看板：scs_take_rate_ads 数据检查

检查日期：2026-10-06（Asia/Shanghai）。已读取规则总览、指定 Airflow 运行与任务状态，以及按业务时间筛选的 DI 日志；首版动态看板已接入现有网页，详见 `automation-dashboard.md`。GSheet 本地实时授权及完整任务日志仍未接入。

## 用户指定入口

- Airflow：`http://34.142.225.103:8080`。
- DAG 与任务：`scs_take_rate_ads`。
- 指定运行：`scheduled__2026-10-06T07:00:00+00:00`，逻辑时间为北京时间 2026-10-06 15:00，不代表实际开始时间。
- [规则 Sheet](https://docs.google.com/spreadsheets/d/1G-QMFOPEuqcUQH5YV4lOAuNoifoZ1NKd9Kc3CJLoGlQ/edit?gid=0#gid=0)。
- 业务日志表（用户已确认）：`cnfashionbi_scs.ads_scs_mature_take_rate_script_data`；使用 DI Livy interactive、队列 `cnfashionbi-dev`、环境 `sg`。

## 已读到的真实规则数据

工作簿标题：`yara_SCS成熟期自动化规则-take rate`。

- `gid=0` 是“自动化规则”调度总览，读取范围 `A1:I21`；包含站点、执行时间、日期状态、负责人、规则页名称和取数时段。
- 具体条件与动作分布在站点规则页，如 `MY for tail`、`TH for tail`；不能把总览直接当成完整规则。
- 读取“脚本介绍” `A1:R40`；包含取数口径、运行安排及加减投规则说明。这些属于说明资料，需要与实际代码和日志核对。
- 抽读 `MY for tail!A1:AY20`，第 16 行为规则表头，包含 take_rate、PC3、订单、广告消耗、Direct ROAS/CPO、预算和开关等字段。

Sheet 中的 waiting/done 是单元格记录，不等同于已经取得 Airflow 终态或广告接口成功证据。当前规则也不能直接当成指定历史运行的规则快照。

## Airflow 查询现状

用户更新 `src/tools/airflow.ts` 后，重新编译并用指定地址重试成功。此次通过进程环境覆盖服务地址，未改写 `.env`。

- DAG run：`success`，实际开始北京时间 15:01:00，结束 16:02:28。
- task：`success`，try_number=1，实际执行约 61.4 分钟。
- 任务日志读取失败：`AIRFLOW_RESPONSE_TOO_LARGE`，超过工具 256 KiB 响应上限。因此未取得完整任务日志，也未确认线上部署的 Sheet ID。
- 查询结果保存于 `.data/automation-agent/scs_take_rate_ads/airflow-2026-10-06.json`。

## 本地调用链检查

本地 `/Users/yara.huang/yara/yara/ads/dag/ads_fourty_cats_dag.py` 的同名 DAG 调用 `ads/executor_scs.py scs`。executor 依据总览的规则名称分派不同实现，`for tail` 页走 `ShopeeAdsV2`，其他页默认走 `ShopeeAds`。

但本地 executor 的 Sheet ID 为 `1ZNK2NN8C-JR_KmMiVd5JmXjNAwIbhWHC3mmSE3Wmr_s`，与本次用户给的 Sheet 不同。不能仅凭本地代码认定线上用错表；需要线上任务日志或部署版本确认关联。

## 待补齐

1. 分段读取超出上限的 Airflow 日志，核对线上使用的规则 Sheet 与规则页。
2. 确认业务 `date` 的时区和运行关联方式。表中没有 dag_run_id，时间窗口只用于候选关联。
3. 扩展当前规则片段为所需的完整规则范围，并核对聊天模型调用与解释工具的表现。

确认后先做运行状态、规则安排、执行汇总和对象明细。实际执行统计必须来自查询结果，不用 Sheet 状态或样例数据替代。

本次规则读取快照：`.data/automation-agent/scs_take_rate_ads/inspection.json`。其中记录元数据、总览和脚本介绍；`.data` 不参与 Git 提交。

## 业务日志的初步字段设计（待查询结果核实）

本地 `ads_scs_mature_take_rate_script.py` 的 DataSuite 输出列声明了以下字段，可作为首版看板的候选映射；这是本地源码检查，不代表已确认 Hive 表结构或线上值。

| 看板内容 | 候选字段 |
| --- | --- |
| 时间、站点、店铺、对象 | date、region、location、shop_id、item_id、campaign_id |
| 命中规则与原因 | rule_type、rule_conditions、reason、trigger |
| 操作配置 | action_type、operation_config、budget_price_type、budget_value、roas_value、state_action |
| 业务结果 | status、execution_mode、execution_status、execution_result、execution_payload |
| 判断用指标 | take_rate、direct_roi、cpdc、roas_bar、cpo_bar、cost、direct_order、PC3 相关字段 |
| 分组动作 | group_name、group_item_ids、group_item_count、eligible_count |

列声明没有发现 dag_run_id；若实际表也没有稳定的运行关联标识，只能先按时间、站点等展示候选日志，不能声称某条日志确定属于指定 DAG 运行。status 与 execution_status 的含义需要通过样例及代码核对，不把 planned 当成执行成功。

## DI 实际查询结果

已通过 DI Livy 执行并完成：

```sql
DESCRIBE cnfashionbi_scs.ads_scs_mature_take_rate_script_data;
SELECT * FROM cnfashionbi_scs.ads_scs_mature_take_rate_script_data LIMIT 5;
```

身份：`yara.huang`；环境 `sg`；session `7122261`；application `application_1789698089543_3868788`；statement 0 和 1 均为 available、output.status=ok。未返回额外 notice。

实际表结构包含本地声明的 64 个业务字段及 `grass_date`、`ingestion_timestamp` 两个分区字段，均为 string。实际结构也没有 dag_run_id。数字字段在展示和计算前需要显式解析，空值不当成 0；date 的时间语义需确认，不能默认与 UTC DAG 逻辑时间相同。

5 条样例来自 2026-09-24 的 BR/BRFA，并不是指定的 2026-10-06 运行记录。LIMIT 5 没有排序或日期过滤，不代表全表最新数据、完整数量或今日执行情况。

样例业务 date 为 9 月 24 日，但 grass_date 分区为 9 月 25 日，ingestion_timestamp 为 `1790267925`。业务执行时间、分区日和入库时间不能混用，后续刷新需要分别展示并定义查询窗口。

样例确认：

- 每条保存了 `rule_type`、JSON 格式的 `rule_conditions` 和 `reason`，可展示命中规则证据。
- 样例 `status=planned` 与 `execution_mode=real`、`execution_status=success` 同时存在：计划状态与实际执行状态必须分开展示。
- 有一条 `execution_result` 提示预算已经最低、没有调整，同时记录 ROAS reset 成功。因此“接口成功”不能自动等同于“预算已变动”；需要细分子动作结果。
- 实际预算变动金额仍需明确的前后值，不能从 success 字样推算。

完整 DI 原始结果保存于 `.data/automation-agent/scs_take_rate_ads/business-log-inspection.json`；结构与选定样例字段摘要保存于 `business-log-summary.json`。这些文件是检查证据，不是已接入定时刷新的服务。

## 按业务时间筛选的 10 月 6 日结果

复用 DI session 7122261，statement 2、3 均完成且 output.status=ok。查询条件为：

```sql
WHERE date >= '2026-10-06 00:00:00'
  AND date < '2026-10-07 00:00:00'
```

筛选业务 `date`，不使用入库日替代执行日。取得全天分组汇总及按 date 倒序的最新 10 条明细；并非下载全天所有明细。时间字符串当前按原值展示，尚未确认时区转换规则。

| 站点 | Sheet 当日状态 | 成功日志 | 失败日志 | 未执行日志 | 业务日志时间范围 |
| --- | --- | ---: | ---: | ---: | --- |
| PH | done（计划 12:10 SGT） | 2898 | 33 | 1934 | 12:31:13–13:34:56 |
| MY | done（计划 15:05 SGT） | 733 | 19 | 1573 | 15:27:49–15:39:08 |
| TH | done（计划 15:30 SGT） | 648 | 30 | 1032 | 15:42:00–16:01:24 |

统计单位为日志行，不是去重商品数、独立接口调用数或新建广告数。`not_executed` 包含规则跳过等情况，不能直接归为失败。Sheet done、Airflow success 与业务执行结果分开展示。

最新明细中的实际失败证据：

- TH，16:01:15，item 58062719608：group_item_resume，广告接口返回 system error。
- TH，16:01:06，item 57858838576：product_operation，加投++，广告接口返回 update fail。

全天查询包含 PH 中午的日志，不能归到指定的 15:00 DAG run。MY、TH 的时间落在该运行窗口内，但缺少稳定 run key 及完整任务日志，暂时仅作为候选关联。

用户已确认 Sheet 的解释方式：`自动化规则` 是当天时间点和是否执行的总览，其他站点 tab 是具体业务规则。首版视图按“当天调度总览 → 站点规则 → 命中条件与实际操作结果”连接证据。

原始结果：`.data/automation-agent/scs_take_rate_ads/business-log-2026-10-06.json`；归一化摘要：`daily-summary-2026-10-06.json`。

## 首版页面验证

- TypeScript 编译与前端语法检查通过。
- 在单独本机预览端口 18791 验证页面，原 18789 服务未停止；原服务重启后可显示新入口。
- 实际点击“刷新数据”，Airflow 成功；DI session 7122261 的 statement 5、6 成功，保存于 `view-2026-10-06.json`。取得 82 条失败明细（查询上限 200），TH 筛选展示 30 条；展开 item 58062719608 可见命中条件、原因和接口 system error。
- 首次刷新 statement 4 已完成，因 CLI 两层身份格式不同被本地校验拦截。只读核对 session owner 后，兼容同一用户名及其 shopee.com 邮箱格式；不是放开任意身份校验。
- automation_report 工具直接调用取得 TH 的相同统计及三条失败示例；尚未验证当前模型自然语言调用此工具的表现。
- GSheet 未提供本地 OAuth token，刷新明确以 partial 结束，保留带时间的规则快照；不声称三个数据源均实时更新。
