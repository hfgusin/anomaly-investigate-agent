# 业务评测结果：evidence

- 时间：2026-10-15 19:39；Agent 模型：`deepseek-v4-1-flash-260910`；评分模型：`deepseek-v4-pro-ga-260813`
- 运行 24 次，完成率 100.0%，评分 24 次
- 任务成功率 91.7%（结论正确 + 必含事实全覆盖 + 无禁止断言）
- 幻觉率 1.3%（无证据或与证据矛盾的断言 / 全部 150 条断言），含幻觉断言的运行 2 次
- 平均工具调用 0.0 次，平均模型调用 1.0 次，平均 token 749
- 耗时 p50 2.9s，p95 4.9s

| 案例 | 类型 | 结果 | 未覆盖事实 / 禁止断言 / 幻觉断言 | 工具 | 秒 |
|---|---|---|---|---|---|
| D01 | source_attribution | 通过 | — | 0 | 3.2 |
| D02 | multiple_failures | 失败 | 缺：退出码 0 不证明业务成功，为什么返回 0 尚未验证。 | 0 | 4.9 |
| D03 | source_attribution | 通过 | — | 0 | 4.3 |
| I01 | executed_operation | 通过 | — | 0 | 2.9 |
| I02 | simulation | 通过 | — | 0 | 2.5 |
| I03 | rejected_operation | 通过 | — | 0 | 2.5 |
| I04 | ambiguous_site | 通过 | — | 0 | 2.2 |
| I05 | time_zone | 通过 | — | 0 | 2.3 |
| I06 | ingestion_vs_operation | 通过 | — | 0 | 1.8 |
| I07 | empty_scope | 通过 | — | 0 | 22.3 |
| I08 | permission_failure | 通过 | — | 0 | 4.4 |
| I09 | script_attribution | 通过 | unsupported：任务启动时间与操作时间接近只是时间巧合 | 0 | 3.5 |
| D01 | source_attribution | 通过 | — | 0 | 4.2 |
| D02 | multiple_failures | 失败 | 缺：退出码 0 不证明业务成功，为什么返回 0 尚未验证。<br>unsupported：`Command exited with return code 0` 说明该命令本身正常退出 | 0 | 4.0 |
| D03 | source_attribution | 通过 | — | 0 | 4.1 |
| I01 | executed_operation | 通过 | — | 0 | 2.0 |
| I02 | simulation | 通过 | — | 0 | 2.6 |
| I03 | rejected_operation | 通过 | — | 0 | 2.4 |
| I04 | ambiguous_site | 通过 | — | 0 | 2.2 |
| I05 | time_zone | 通过 | — | 0 | 1.7 |
| I06 | ingestion_vs_operation | 通过 | — | 0 | 2.3 |
| I07 | empty_scope | 通过 | — | 0 | 2.2 |
| I08 | permission_failure | 通过 | — | 0 | 3.0 |
| I09 | script_attribution | 通过 | — | 0 | 3.0 |
