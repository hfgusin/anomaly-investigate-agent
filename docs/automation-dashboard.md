# SCS 广告自动化看板

## 打开与使用

重启现有服务后，点击左侧“自动化看板”，或访问 `http://127.0.0.1:18789/#automation`。

1. 选择业务日期。日期变化会读取该日已保存结果；没有结果会显示未取得数据，不会显示另一日的业务统计。
2. 选择站点。汇总、操作分类、失败明细和当前规则片段随站点变化。
3. “刷新数据”重新读取 Airflow、DI，以及已授权的 GSheet。进度中显示 SQL statement ID；重复点击不会并发提交第二次刷新。
4. 展开失败明细，核对 item/campaign、命中原因、执行时规则条件、接口结果。
5. “每 60 秒读取缓存”只刷新页面缓存，不每分钟运行 Spark 查询。

聊天可问“查看 2026-10-06 TH 的自动化执行情况”。`automation_report` 工具读取同一份保存证据，返回来源、时间、状态和看板链接；它不自行刷新外部数据。模型是否正确调用和解释该工具仍需人工验收。

## 数据范围

- 固定首个案例：scs_take_rate_ads、用户给定 Sheet 和业务日志表。浏览器/模型不能指定任意 SQL、表名、服务器地址或命令。
- Airflow 查询所选日期逻辑时间 15:00 的运行和同名任务；不是全天运行列表。完整任务日志尚未接入。
- DI 查询业务 date 的一天半开区间，汇总所有执行状态；明细读取当天最新 200 条失败日志，达到上限时可能不全。
- 初始检查快照是最新 10 条任意状态日志，其中只有两条失败；刷新后才取得专门的失败明细。
- 日志统计不等于去重商品数、广告数或接口调用数。没有 dag_run_id，不能用时间相近宣称确切归属某次运行。
- Sheet 总览状态列的日期与所选日期不一致时，不把当前 done 用于历史日期。
- 当前只读取 MY/PH/TH for tail 第 16–30 行作为规则对照片段，其他规则页通过工作簿链接查看。执行时实际条件以业务日志中的 rule_conditions 为准。

## 授权和刷新

DI 复用 `.data/automation-agent/scs_take_rate_ads/inspection.json` 的 session，或 `.env` 的 `AUTOMATION_DI_SESSION_ID`。session 过期时显示失败，不自动创建/停止 Spark session。使用已登录的本机 di CLI，环境固定 sg。`AUTOMATION_DI_BIN` 可指定 CLI 绝对路径。

GSheet 的 Codex 连接授权不能直接当成本地应用授权。没有 `AUTOMATION_GSHEET_ACCESS_TOKEN` 时明确显示规则快照与采集时间；有已有 OAuth access token 时，用只读 values.get 接口取总览和规则片段。access token 过期需在本地更新并重启；当前尚无自动 OAuth 登录/续期流程。[Google Sheets values.get 文档](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)

所有读取失败保留旧结果并标注错误，不把失败显示成零。刷新状态、statement ID 和每次 job 历史保存于 `.data/automation-agent/scs_take_rate_ads/`。服务重启把进行中的刷新标记 interrupted，不自动重新提交 SQL。尚未提供页面中继续轮询旧 statement 的恢复按钮；可凭记录的 ID 在 DI 查询原结果。

## 代码入口

- `src/automation-dashboard.ts`：日期校验、真实查询、汇总、快照与刷新状态。
- `src/server.ts`：只读视图 GET 和带同源检查的刷新 POST。
- `public/automation-dashboard.js`：日期/站点交互、证据和规则展示。
- `src/tools/read-file.ts`：注册 automation_report，供聊天读取已有证据。

## 手动验收

1. 10 月 6 日全部站点初始检查数据：成功 4279、失败 82、未执行 4539（均为日志行）。
2. 选择 TH：成功 648、失败 30、未执行 1032。
3. 刷新完成后，失败明细应标注最多 200 条，且显示新的采集时间和 SQL ID。若数据有新入库，统计可变化，以查询结果为准。
4. 展开 item 58062719608 的记录，应能看到 group_item_resume 和 system error，而非仅看 Airflow success。
5. 无 Sheet 授权时明确提示规则快照；不能显示“全部数据实时更新成功”。
