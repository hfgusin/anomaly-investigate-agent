# 意图路由评测

- 时间：2026-10-15 19:31；测试集 40 条（{'daily-check': 10, 'ads-check': 10, 'general': 10, 'clarify': 10}）

| 方案 | 准确率 | 失败 | p50 | p95 | 平均 token | 主要混淆 |
|---|---|---|---|---|---|---|
| 关键词规则 | 62.5% | 0 | 0ms | 0ms | 0 | clarify→general×7、general→daily-check×3、clarify→daily-check×3、daily-check→ads-check×1 |
| 小模型零样本（doubao-seed-2-0-mini-260428） | 95.0% | 0 | 1048ms | 1879ms | 911 | daily-check→clarify×2 |
| 小模型 + 大模型标注示例 40 条 | 100.0% | 0 | 987ms | 1659ms | 1411 | — |
| 大模型零样本（deepseek-v4-pro-ga-260813，开启思考） | 100.0% | 0 | 2961ms | 5767ms | 861 | — |
