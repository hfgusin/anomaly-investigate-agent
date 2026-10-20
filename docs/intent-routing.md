# Python RAG 意图路由

## 选择的方案

使用 LangGraph 编排模型决策、样例检索、相关性评判、问题改写和结构化分类。没有训练 BERT 分类头，也没有实现 OpenMax、概率校准或完整的级联分类器。

这是“检索 few-shot 样例”的意图路由图。复用教程的检索、评判和改写循环，但最终产出项目需要的 Route，不在这一步生成业务问答答案。广告知识库仍是独立链路。

```text
用户输入 + 最近两轮对话
    → generate_query_or_respond
        ├─ 调用 Route → 直接输出路由 → END
        └─ 调用 retrieve_examples → ToolNode 检索
            → grade_documents
                ├─ 相关 → generate_answer → 输出 Route → END
                ├─ 不相关 → rewrite_question → 回到决策节点并强制检索
                └─ 已改写两次仍不相关 → 丢弃样例 → 根据路由定义输出 Route → END
```

显式 `/daily-check` 等命令直接选择 Skill，跳过意图模型。网页、会话和审批仍由 TS Gateway 管理；本地向量计算与意图判定在 Python。

## 代码阅读顺序

1. `python/agent_backend/intent_retrieval.py`：LangChain Embeddings、缓存、Document 和 Retriever 的组合，不再手写 tokenizer、pooling、向量排序或缓存 SQL。
2. `python/agent_backend/intent_graph.py`：`MessagesState`、`StateGraph`、`ToolNode`、条件边和改写循环；Pydantic 约束路由、相关性判断和改写结果。
3. `python/agent_backend/router.py`：`classify_rag()` 调用编译后的图，保留原始输入和近期对话，汇总节点记录和 token usage。
4. `src/intent-router.ts`：通过 stdin 把问题与历史交给 Python；退出非零时沿用已有通用模式回退。
5. `src/run-coordinator.ts`：读取当前会话最近两轮已完成对话；处理路由、Skill 快照和工具范围。

输入不要求用户写斜杠命令。近期历史每条最多 500 字符；这是有限上下文，不是完整会话记忆。新输入明确切话题时应优先处理新输入，缺少可继承对象时澄清。

## 本地检索与缓存

使用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`，固定 revision `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`，384 维、128 token 窗口、CPU 推理。`HuggingFaceEmbeddings` 负责加载 Sentence Transformers 模型和 tokenizer，`normalize_embeddings=True` 负责归一化。设置 `local_files_only=True`，缺少模型时直接报错，不在用户提问时下载权重，不调用 Embedding API。

本机已有这份 Hugging Face 模型缓存，约 458 MiB，直接复用。它与 TS 广告知识 RAG 的 ONNX q8 模型是不同格式；后者仍保留，`RAG_ONNX_MODEL_PATH` 仅影响原 ONNX 链路。新环境需先安装依赖，再显式下载固定版本：

```bash
.venv-di/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", revision="e8f8c211226b894fcb81acc59f3b34ba3efd5f42")'
```

样例保存在 `config/router-examples.json`。LangChain `LocalFileStore` 将样例向量缓存到 `.data/intent-router/embeddings/`，命名空间包含模型、revision 和归一化设置，缓存 key 使用 SHA-256。新增样例时只编码新文本；改 route 标签无需重算同一文本的向量。索引指纹包含上述命名空间和当前全部样例。旧 `examples.sqlite` 不再读取，也未删除。

向量索引使用 `InMemoryVectorStore`，每个进程从磁盘缓存的向量重建；磁盘持久化的是向量，不是完整向量数据库。每次路由仍计算当前 query 向量；`cache_hit` 指本次索引初始化时全部样例向量已存在，不是历史分类答案命中。

Retriever 使用框架的 MMR：先取最相似的 20 个候选，再兼顾相关性和差异性选 6 个，`lambda_mult=0.7`。它不保证每类最多两条。Trace 返回 `rank` 和 `search_type=mmr`，不再返回手工计算的 `score`。所有路由定义仍提供给模型，避免未召回正确类时强行误分。新增路由仍需同步 Route schema、路由定义和 Skill 范围。

检索词由模型从原始输入和近期对话生成，实际查询参数保存在 Trace。改写检索词不替换原始请求；评判和最终分类始终读取原始请求。MiniLM 自身仍有 128 token 窗口，超过窗口会由 Sentence Transformers 截断；不输出无法从标准 Embeddings 接口确认的 `query_truncated`，也不再返回旧的 `input_excerpted` 字段。

最多改写两次，即最多三次检索。达到上限时，最终分类不使用被判不相关的样例，Trace 标记 `rewrite_limit_reached`。这是零样本分类兜底，不代表已经找到证据。检索异常直接传播，不能当成“不相关”继续循环。图限制为 20 个 supersteps、90 秒总耗时；TS 子进程超时为 95 秒，错误沿用 Gateway 的通用模式回退。总 token usage 汇总所有图内模型调用。简单路径调用一次模型；一次检索路径通常调用三次；两次改写的最长正常路径调用九次模型，成本和延迟均可能上升。

## 六种路由及边界

- `daily-check`：Airflow 运行失败、日志和 traceback 排查。
- `ads-check`：固定 scs_take_rate_ads 自动化报告，不代表所有广告业务。
- `source-lookup`：哪个表、哪个脚本、业务来源与已映射操作追溯。
- `general`：普通问答、概念解释、代码讨论。
- `clarify`：实际请求缺少能确定任务的线索；不继承不明确的对象。
- `out-of-scope`：当前没有提供的实际业务操作，例如创建广告组、修改预算或重跑 DAG。

OOS 是“不属于当前业务工具范围”，不等于所有非广告问题；例如解释 Python 概念仍归 general。OOS 与 clarify 都清空工具定义并关闭 hosted search，再生成不执行/澄清说明。拒识本身由模型决定，仍可能出错，工具禁用仅在该路由已正确返回时生效。

## 启动与检查

可通过 [本地 Studio](studio.md) 可视化调试同一份图；现有网页仍沿用原 Gateway 入口。

当前本地 `.env` 已开启 `MIRROR_ROUTER=true`。`ROUTER_MODEL_NAME` 未填写时沿用已有默认路由模型，认证复用当前 `MODEL_BASE_URL/MODEL_API_KEY`。

```bash
# 项目根目录；新增 Python 依赖已在本机安装
uv pip install --python .venv-di/bin/python -r python/requirements.lock.txt
npm run build && npm start

# 完全离线查看召回，不调用分类模型
cd python
../.venv-di/bin/python -m agent_backend.router --retrieve "帮我定位某个 DAG 的报错"

# 只测本地候选召回
../.venv-di/bin/python -m evaluation.run_router retrieval

# 真实模型分类评测：仅使用合成开发题，产生模型调用费用
../.venv-di/bin/python -m evaluation.run_router rag
```

网页任务详情的时间线会显示 `intent.route`：最终路由、最后一轮召回和 `trace` 数组。数组逐步保留模型选择的工具及参数、每轮样例及排名、相关性判断及一句话公开依据、改写查询和是否用样例完成分类。这些是决策结果，不是模型内部思考。总耗时不含 TS 启动 Python 的全部开销，不能当完整用户响应延迟；图全部结束后才返回这份记录，尚未实现逐节点实时推送。

当前 Gateway 仍然每次路由启动一个 Python 进程；模型直接选择 Route 时不加载本地 Embedding 模型，需要检索时才加载。此前新进程 CLI 检索实测 7.48 秒（包含进程、依赖和模型加载，不含分类 API）。未改成常驻服务，也未证明图编排降低整体延迟。

## 验证记录与限制

本次新增 16 个合成开发题：3 个 OOS、3 个多轮/省略表达，其余覆盖三个 Skill、通用问答和澄清。gold route 仅用于执行后的计分，不传给分类模型。开发题不是封存测试集，不能据此宣称生产准确率。

首轮候选 route Recall@6 为 15/16；真实模型分类也是 15/16，OOS 为 3/3。一个商品来源题未召回正确类，但模型依靠路由定义分对；一个带历史的“那今天呢”被过度澄清。初次报告保存为 `.data/evaluation/router-rag-initial.json`，修改省略追问规则后另存新结果，不覆盖该失败记录。

后续结果在 `.data/evaluation/router-rag-live.json`，包含代码/样例指纹、数据集指纹、模型名称和逐题实际分类。没有与同题的全量 few-shot 基线完成配对评测，因此不能断言检索增强已经提高分类准确率；当前确定减少的是每次提供给模型的样例数。

本轮不包含槽位抽取、微调小模型、分数阈值校准或自动发现新意图。已有广告知识 RAG 的召回质量也不由本次意图测试证明。

2026-10-19 旧 ONNX 实现复测：修改省略追问规则后，同一 16 个开发案例分类 16/16、OOS 3/3，候选 Recall@6 为 15/16。该结果不能作为本次 Sentence Transformers + MMR 改造的结果，两者权重精度和召回策略不同，需重新验证。

本次 LangChain 改造后复测：51 个相关 Python 测试、10 个 Node 路由/工具测试和 TS 构建通过。实际使用本地模型验证 384 维归一化向量、MMR 召回、缓存复用和新增文本增量编码。16 个合成开发题候选 Recall@6 为 16/16；再调用真实分类模型，分类 16/16、OOS 3/3、调用错误 0。旧报告保留为 `.data/evaluation/router-rag-onnx.json`，新报告为 `.data/evaluation/router-rag-live.json`。同一开发集此前已经参与调提示，结果不代表生产准确率，也不足以证明 MMR 普遍优于旧策略。

以上 16/16 是接入图之前的历史记录，不作为新图的质量结果。图的分支测试使用真实 LangGraph、替换外部模型响应，覆盖直接路由、检索后分类、不相关后改写、改写上限、检索异常、历史和 usage。在线评测中 `retrieval_cases` 表示实际进入检索的题数，Recall@6 只以这些题为分母；绕过检索的题不计作召回失败。

2026-10-19 接入图后：55 个相关 Python 测试、11 个 Node 测试和 TS 构建通过。真实模型重跑同一开发集，7 题直接路由、9 题进入检索，分类 16/16、OOS 3/3，检索题候选 Recall@6 为 8/9。这批正常题没有触发改写，相关性评判仍可能过宽，不能把最终分对视为每次检索都正确。结果保存于 `.data/evaluation/router-rag-live.json`，前一版报告已另存 `router-rag-before-graph-*.json`。

另外用一条合成开发题做真实模型故障注入：人为让首次检索返回空样例，第二次使用真实本地 MiniLM 检索。实际路径为「决策 → 检索 → 判不相关 → 改写 → 再决策 → 再检索 → 判相关 → 分类」，共两次检索，结果为 daily-check。完整查询、评判和改写记录在 `.data/evaluation/router-graph-rewrite-live.json`。这是受控故障注入，不代表真实知识库的检索质量。

参考：[LangGraph Agentic RAG](https://docs.langchain.com/oss/python/langgraph/agentic-rag)、[LangChain Sentence Transformers](https://docs.langchain.com/oss/python/integrations/embeddings/sentence_transformers)。相关性判断独立为节点，因此可以在 Trace 中保留结果；教程在条件路由函数中进行该判断。内部只提供本地样例检索工具，不执行 DI、Airflow、GSheet 或其他业务工具，业务审批仍在后续主 Agent 中。
