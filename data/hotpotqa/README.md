# HotpotQA 数据来源

- 任务：HotpotQA `distractor` validation。每道题自带候选 Wikipedia 段落、标准答案和 `title + sent_id` 支持事实；运行时工具只返回候选段落，不返回答案或标准支持事实。
- 官方项目：[HotpotQA](https://hotpotqa.github.io/)；可用镜像：[hotpotqa/hotpot_qa](https://huggingface.co/datasets/hotpotqa/hotpot_qa)。数据与处理后的 Wikipedia 文本许可为 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。
- 仓库内 `validation-sample.json` 是 validation 第 2 条，ID `5a8c7595554299585d9e36b6`，保留原题、答案、全部 10 篇候选资料和支持事实。它用于离线烟测，不是基准成绩。
- 本机完整集位于被 Git 忽略的 `.data/hotpotqa/validation.parquet`，来源为镜像仓库 `distractor/validation-00000-of-00001.parquet`；文件大小 27,452,575 字节，SHA-256 `c20b638ca82b21d04fe12e14ff417ad05153d4d215a65de54497fca4e972f7c6`。转换后 `.data/hotpotqa/validation.json` 有 7,405 条记录。
- 重建：下载上述 Parquet 到 `.data/hotpotqa/validation.parquet`，用 `python3 -m pip install --target /private/tmp/hotpot-py duckdb` 安装临时读取库，然后运行 `PYTHONPATH=/private/tmp/hotpot-py python3 scripts/import-hotpot.py`。本地如果有完整 JSON，Gateway 自动使用它；否则回退到仓库中的单条样例。可用 `HOTPOTQA_DATA_FILE` 指定其他完整 JSON。

这是 **distractor** 设置：每题已有 10 篇候选文章。当前尚未接入 7.4 GB 的完整 Wikipedia 语料，因此不能称为 fullwiki 开放域检索。
