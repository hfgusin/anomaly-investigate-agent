# 多跳资料研究：第一轮证据

## 实现

输入 `/research <HotpotQA 原题>` 激活 `multi-hop-research` Skill。工具先按题目词检索候选段落，再从首跳段落中识别被提及的其他候选文章，返回第二跳。每句附 `Title#sentId`；运行记录显示 Skill 版本、工具参数、两跳候选与完整句子。检索在独立 Worker 中执行；请求超时或 Worker 崩溃时本次失败，下次调用创建新 Worker，不自动重放可能已执行的调用。重复 Worker 返回按请求 ID 只接受第一次。

本机模型接口使用 `MODEL_TOOL_RESULT_MODE=plain`，每个 Run 只有一轮模型工具调用，因此两跳资料检索封装在一次 `research_hotpot` 工具调用中。模型负责从返回的段落推理并作答。回答若缺少首跳或次跳真实句子引用，Run 标为失败并保留原输出；这只能检查出处链是否完整，不能保证答案正确。

## 数据与可复现评测

完整 HotpotQA `distractor` validation：7,405 题，每题 10 篇候选文章。`node scripts/eval-hotpot-retrieval.mjs` 的本机最新结果：

| 指标 | 结果 |
| --- | ---: |
| 找齐全部标准支持句的题 | 6,329 / 7,405 = 85.47% |
| 检索到的标准支持句 | 16,420 / 18,005 = 91.20% |
| 第二跳由首跳文章明确链接到另一篇 | 4,079 / 7,405 |

这些是**候选证据覆盖率**，不是最终问答准确率。标准答案与支持句只在评测脚本中读取，不进入工具返回结果。

本轮针对实体名和文章别名调整排序，保持每题返回 3 篇首跳、2 篇次跳资料。修改前的完整证据召回是 5,863/7,405（79.18%）。曾试过返回 4+3 篇，召回达到 6,710/7,405（90.61%），但固定 10 题的真实模型联合精确匹配从 1/10 降到 0/10，因此撤回了扩大候选数的改动。

新模型 `doubao-seed-2-0-mini-260428` 接入后，保持 3+2 篇，只将首跳完整点名的次跳文章排在仅别名匹配的文章前。完整支持句覆盖从 6,281 增至 6,329 题；固定 10 题的真实模型答案精确匹配从 4/10 变为 5/10，支持事实精确匹配仍为 6/10，联合精确匹配仍为 3/10。新增答对的是《Sex and the City》集数题：检索现在返回主剧文章，模型回答 94，但少引了一个标准支持句。两轮模型输出有随机波动，不能把 1 题的差值直接归因于检索改动。原始记录在本机 `.data/hotpotqa/doubao-seed-2-0-mini-260428-check.json` 和 `doubao-seed-2-0-mini-260428-bridge-v2.json`。

同一新模型用 `MODEL_TOOL_RESULT_MODE=standard` 试跑 3 题，均完成一次工具调用与后续生成；这尚不证明多轮工具调用稳定。模型曾把两个合法引用写成 `[A#0, B#1]`，旧解析器误判为一个不存在的引用。运行时和离线评测现共用解析器，能拆开核验每个句子引用，未知引用仍会被拒绝。对已保存的 3 题原文重新评分后，其中一题的联合精确匹配从误记的 0 改为 1；没有重新调用模型。

固定诊断样本：用 `2026-09-30-hard-bridge-v1` 对 validation 中的 hard bridge 题 ID 做 SHA-256 排序，取前 10 题。运行 `node scripts/eval-hotpot-batch.mjs 10 .data/hotpotqa/live-check.json` 会保存题目 ID、原始输出、答案 EM/F1、支持事实 EM/F1、联合指标和接口错误。此样本用于开发排查，规模太小，且已多次用于调试，**不作为无偏的最终基准成绩**。当前接口输出存在波动；同一题集在 `temperature=0` 的两次试跑中联合精确匹配分别为 1/10 和 0/10，不能把单轮分数差别直接归因于代码变更。

本轮确认并修复了当前服务商的一种流式兼容问题：同一工具调用先发送带工具片段的 `stop`，随后发送 `tool_calls`。修复前固定 10 题有 3 题在执行工具前报“结束标记冲突”；修复后同组的一次试跑 10/10 完成工具调用。其他互相冲突的结束标记仍会报错。答案质量仍是主要未完成项；当前模型会选错实体、遗漏标准支持句或不按要求写出处。一个二次模型复核实验没有提高联合指标，未接入产品。

真实模型单题试跑命令：`HOTPOTQA_DATA_FILE=.data/hotpotqa/validation.json node scripts/eval-hotpot.mjs <题目 ID>`。当前记录：

- `5a8c7595554299585d9e36b6`：工具找到了 `Kiss and Tell (1945 film)#0` 与 `Shirley Temple#1`；模型最终选择大使而非标准答案 `Chief of Protocol`。一次 CLI 试跑支持句 F1 为 0.8、答案 EM 为 0；页面试跑也给出大使，且漏掉首跳引用。这道题**未通过**。
- `5a8e3ea95542995a26add48d`：模型引用了 `Big Stone Gap (film)#0` 和 `Adriana Trigiani#0`，支持事实 EM 为 1；答案输出 `Greenwich Village`，标准答案是 `Greenwich Village, New York City`，严格答案 EM 为 0。这道题的出处通过，严格答案未通过。

故障注入：`tests/research-worker.test.mjs` 分别注入 Worker 挂起、重复回复、异常退出，并检查超时终态、重复去重、下一次调用重新启动 Worker。`pnpm test` 还覆盖 Gateway 持久化、幂等和崩溃恢复。故障注入不等于生产负载或高并发性能测试。

## 你可以在页面验收

打开 [本地页面](http://127.0.0.1:18789)，新建会话，发送：

```text
/research The director of the romantic comedy "Big Stone Gap" is based in what New York city?
```

页面出现 `research_hotpot` 请求时点「允许这次」。展开「运行记录」，应看到 `Skill：multi-hop-research v1`、`Big Stone Gap (film)` 在首跳、`Adriana Trigiani` 在次跳，以及每句的 `Title#sentId`。标准答案为 `Greenwich Village, New York City`，标准支持句为 `Big Stone Gap (film)#0` 和 `Adriana Trigiani#0`。请按页面最终输出核对：如果只答 `Greenwich Village`，这是严格答案错误，不应算通过。
