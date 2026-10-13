# 广告投放 RAG：语料准备

当前完成资料下载、清洗、本地 MiniLM 向量化与独立检索入口，并提供检索后的模型中文翻译与有出处的回答。尚未接入网页 Agent 问答。

## 本地 MiniLM 向量化与检索

现在使用 TypeScript + Transformers.js + ONNX Runtime，不需要 Python 或 API Key。同款多语言 MiniLM 使用 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` 的 ONNX q8 发布版，固定 commit `2c4055b12046f11709e9df2c122e59ffbdc2f900`。量化和 tokenizer 实现与旧 Python 版本不同，不承诺排序完全相同。

代码入口：`src/ads-rag/cli.ts` 处理命令，`model.ts` 管模型下载和本地推理，`index.ts` 管切块、索引和混合检索。

本地加载方式参考 [Transformers.js 官方文档](https://huggingface.co/docs/transformers.js/en/custom_usage)。当前机器已完成模型下载与 TS 索引构建，可以直接执行 `rag:search`；此次构建 1202 个父片段、4029 个窗口，最长输入 122 tokens。查询效果需要重新人工确认，不能沿用旧 Python 版本的质量结论。

```bash
# 新环境先 pnpm install；首次下载固定 ONNX 模型需要网络
pnpm rag:setup

# 本地计算向量，完成批次可缓存复用
pnpm rag:index

# 检索后用 .env 中已有模型生成中文翻译、解释与引用答案
pnpm rag:search "广告预算消耗低于计划，应该怎么排查？" --limit 3
pnpm rag:search "Meta 广告素材疲劳怎么判断？" --platform meta --limit 3
pnpm rag:search "Google Ads 目标每次转化费用有哪些限制？" --platform google --kind official_documentation --limit 3

# 只做本地检索，不调用聊天模型，不产生翻译模型费用
pnpm rag:search "预算为什么花不出去？" --limit 3 --raw
```

### 运行边界

- 全部执行逻辑在 TS 中，不启动 Python 子进程；模型由 Node 的 ONNX Runtime 在 CPU 上执行。
- 只有 `rag:setup` 联网下载模型，权重验证固定 SHA-256；配置文件保存哈希，加载时再次核对。`index/search` 使用 `allowRemoteModels=false` 和 `local_files_only=true`，缺文件明确失败。
- 默认模型目录 `.data/ads-rag/models/minilm-q8`；如需自定义目录，在 `.env` 设置 `RAG_ONNX_MODEL_PATH` 后执行 `rag:setup`。原 Python 的 `RAG_MODEL_PATH` 和 `RAG_DEVICE` 不再生效。
- 模型窗口 128 tokens，输出 384 维；使用模型实际 tokenizer 计数，每个最终 embedding 输入都不超过上限。
- 原始父片段完整保留；向量窗口最多 104 个正文 tokens，加上最多 16 tokens 的简短标题上下文与特殊 tokens；最终组合重新计数。重叠后缀最多 16 tokens。通过原文字符切分，不把 token 解码后的文字冒充原文。
- 向量输入将 Markdown 链接转换为链接文字，避免网址浪费窗口；完整原文链接仍保留在父片段和来源元数据中。
- 优先在句子或段落边界结束窗口；遇到长句、表格、代码仍可能切开。窗口字符区间基于去掉链接地址后的派生正文（见 `char_basis`），不是原始 Markdown；完整父片段仍可检查，不能认为所有子窗口独立可读。
- 查询也检查 128-token 上限，超限明确拒绝，不偷偷截断问题。

### 本地文件和恢复

- `.data/ads-rag/index.json`：当前索引路径、模型指纹、依赖版本、语料哈希与实际统计。
- `.data/ads-rag/indexes/*.sqlite`：父片段、子窗口、float32 归一化向量。构建完成后才原子发布，失败不替换已有索引。
- `.data/ads-rag/embedding-cache-ts.sqlite`：每批提交的 TS 向量缓存，中断重跑可复用。模型/推理版本/输入改变会使用不同缓存键。
- `.data/ads-rag/last-search.json`：最后一次实际检索结果。
- 默认搜索还保存 `answer_zh`：中文结论、来源编号、片段中文翻译和解释。`.data/ads-rag/last-answer.md` 是便于阅读的同一份回答；生成失败时删除旧回答并保存 `generation.status=failed`，检索结果仍可检查。
- 语料更新后查询提示 `INDEX_STALE`；需要重建。模型或推理版本改变提示 `MODEL_CHANGED`，也需重建。旧 Python 索引提示 `INDEX_RUNTIME_CHANGED`，必须重新 `rag:index`，不混用两种推理方式的向量。

旧 Python 的索引、缓存与 `.venv-rag` 保留在磁盘上，但新命令不再使用它们；迁移不自动删除这些文件。ONNX q8 权重约 113 MiB，另有 tokenizer 和 Node 推理依赖。构建完成后原子更新 `index.json`，之前的索引文件仍保留供回退；旧检索质量记录仅代表旧版本。

向量存储是本地 SQLite，不需要安装向量数据库服务。当前规模采用精确向量扫描；关键词侧是英文词与中文二元词的 BM25，补充明确的投放术语映射（例如预算→budget、消耗→spend、疲劳→fatigue）。两个通道按父片段去重后用 RRF 合并，不让重叠窗口挤占所有结果。术语映射不等于通用翻译，没有调用外部模型。

### 你如何判断有没有查对

默认终端先展示中文结论和引用编号，再展示每条来源的中文标题、章节、完整命中片段翻译、证据解释、真实链接、版本、类型和审核状态。按 `[S1]` 等编号逐条对照。翻译只覆盖实际命中的短窗口，不冒充完整文章翻译；完整父片段仍保存在 `parent_text` 中。

中文生成使用已有的 `MIRROR_RUNTIME`（responses 或 chat-completions）、`MODEL_BASE_URL`、`MODEL_NAME` 和 `MODEL_API_KEY`。发送问题和命中片段到配置的模型服务商，会产生该模型的调用费用。请求没有联网搜索工具，来源链接由本地检索结果填入，不允许模型编造链接。没有命中结果时无需调用模型，直接说明证据不足。`--raw` 保持全离线检索，并输出 JSON 与原有术语导读。

命令显示两个阶段的耗时：本地检索、模型生成。中文生成请求使用流式响应，每 5 秒显示等待时长和已接收字符数，完整结束后才解析、校验并发布中文回答；流中断或未收到成功终态不算完成。Responses 翻译任务单独设置 `thinking=disabled`，不改变网页 Agent 的全局配置。总生成超时仍为 120 秒。

代码校验每条回答的来源 ID 是否真实存在、模型是否遗漏来源翻译、是否引用了其自身判断不相关的片段。翻译、解释、相关性和结论仍由模型生成，校验引用 ID 不等于已验证其语义正确，也不能保证翻译完全准确。证据不足会明确标注；没有检索置信度阈值，仍需人工确认。

使用 `--raw` 或 JSON 核对时看 `title`、`section`、`matched_window` 与 `source_url`，需要条件和上下文时看 `parent_text`。`channels` 给出向量相似度和关键词分数；`rrf_score` 是排序分数，不能当“答案正确概率”。

平台标签是之前自动分类的结果，筛选指定平台时也包含通用资料。输入无关问题仍可能得到最近邻候选，目前没有经过校准的相关性拒答阈值；不要把排第一等同于可用证据。官方文档、社区经验、模拟案例保持原有分类。

依次试预算消耗、Meta 素材疲劳、Google 出价限制三个问题，查看实际命中来源；中文检索英文资料及生成翻译的效果需要你确认。中文回答只依据命中片段，不自动调整广告账户。

## 运行入口

```bash
cd /Users/yara.huang/Documents/ui/openclaw-mirror
pnpm rag:prepare
```

不需要模型密钥；需要 git 和网络。仓库按 `data/ads-rag/sources.json` 的 commit 读取，不自动追最新版本；Google 页面在线重新获取。

已有缓存时可以不联网，使用原始资料重新清洗：

```bash
pnpm rag:prepare --offline
```

入口代码是 `src/ads-rag/prepare.ts`，正文提取和切块在 `src/ads-rag/corpus.ts`。无需启动网页或 Gateway。

## 到哪里看结果

每次运行生成独立快照，不覆盖之前的文件。`.data/ads-rag/latest.json` 指向最新一份：

- `review.md`：文档索引、分类、来源与正文样例，先看这个。
- `manifest.json`：成功/失败状态、统计、每份原文与清洗文件的路径、SHA-256、版本、选入/排除记录。
- `chunks.jsonl`：一行一个完整 JSON 对象，可供后续检索建库读取。
- `raw/`：下载的原始 Markdown 和 HTML。
- `clean/`：提取并清洗的正文。
- `licenses/`：原始 MIT 许可及 Google 页面许可出处记录。

`.data` 已被 Git 忽略，提交代码不等于提交语料。迁移语料需另行复制快照；清单中的本机路径需要重新生成。

## 本次选择的资料

| 来源 | 范围 | 类型 |
| --- | --- | --- |
| Corey marketingskills | ads、ad-creative、analytics、attribution、ab-testing | 社区方法论 |
| mbfinotti advertising-skills | 账户诊断、预算、出价、归因、转化追踪、素材疲劳、测试与扩量 | 社区方法论 |
| 中文异常诊断 Skill | 诊断方法及 3 个案例 | 方法论；案例明确为模拟 |
| Google Ads 开发文档 | 中文出价概览/类型、预算概览/创建、转化管理，共 5 页 | 官方文档 |

仓库保留独立 MIT 文件并校验；Google 页面需存在 CC BY 4.0 许可链接，正文与代码分别记录许可，其他声明例外仍需审核。不采集没有明确许可的中文仓库、付费课程或第三方 PDF。

## 清洗和切块规则

1. 去掉 Markdown 的 Skill 元数据块，排除安装、许可、贡献、目录、相关 Skill 等章节；不加载或执行下载的 Skill。
2. Google 只提取文章正文，移除页面按钮、导航、收藏提示和图标，保留章节、表格和代码。
3. 按章节组合完整段落、列表、表格、代码块，目标约 2200 字符；不在不同章节间拼接，也不硬切代码或表格。
4. 超长完整块保留并标记 `oversized=true`，后续索引阶段再根据 Embedding 输入限制决定处理；当前不是所有块都符合向量模型上限。
5. 只合并类型、平台一致且正文完全相同的片段，保留重复来源。没有做语义去重。
6. 保存标题、章节、原始章节行号范围、来源、版本、许可、时间、语言、平台、主题和资料类型。

`section_line_start/end` 是原文所在章节的行号范围，不是片段的精确行号；Google 的行号基于转换后 Markdown。`source_updated_at` 在仓库来源中是 commit 时间，在 Google 来源中是页面更新时间；不是文章最初发布日期。Git 文档的 `fetched_at` 表示本次读取/物化缓存时间，Google 页面保留实际抓取时间。

平台和主题是文档级关键词分类，可能过宽；所有片段为 `review_status=unreviewed`。社区资料的百分比、停投阈值、预算分配不自动视为官方规则或可靠行业基准。模拟案例单独标注 `synthetic_case`。

`instruction_policy=data_only` 是交接给后续 Runtime 的要求，目前检索只返回资料；字段本身不能防止提示注入。

## 你参与验收

先打开 `review.md`，重点挑下面几份：

1. **Google 出价策略类型**：标题没有网页杂文；策略表格的列名与说明完整。
2. **中文低 CTR 案例**：来源和模拟数据标识清楚；条件、基准和计算没有丢失。
3. **Meta Decision System (B2B)**：B2B 的条件保留，数值门槛被归类为社区经验。
4. **Budget Pacing**：预算、时间范围、计算条件完整，没有只留下结论。

告诉我“这个文档/章节没用”“这里切断了条件”“这个平台标签不对”，就能直接调整来源和切块规则。

## 失败与复现

单个来源失败时会继续生成其他资料，清单标记 `partial` 并返回非零退出码；不能把 partial 当成全部下载成功。失效链接、许可未确认、正文提取失败等保留明确错误码，不自动使用旧网页冒充新抓取。

新快照保留来源配置哈希、清洗代码哈希、原文哈希和语料哈希。离线重跑不调用模型，也不替换原文。`latest.json` 通过临时文件重命名发布；排他锁防止同时运行。进程异常退出留下锁时，先确认已无 prepare 进程，再删除 `.data/ads-rag/prepare.lock`。

下一步：人工确认检索结果后，将本地检索注册为 Agent 工具，在网页展示引用与完整运行记录。
