# 本地 LangSmith Studio

## 启动

在项目根目录运行：

```bash
uv pip install --python .venv-di/bin/python -r python/requirements-studio.txt
npm run studio
```

- 本地 API：`http://127.0.0.1:2024`
- API 文档：`http://127.0.0.1:2024/docs`
- [打开 Studio](https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024)

Studio 网页需要登录 LangSmith。当前本地服务不需要 LangSmith API key；模型认证复用项目 `.env` 的 MODEL_BASE_URL / MODEL_API_KEY，模型使用 ROUTER_MODEL_NAME 或现有默认路由模型。修改 `.env` 后重新启动服务。

Studio 连接本地服务可免费使用；实际模型调用仍按模型服务商计费。当前未开启云端 Tracing，也未创建 LangSmith 云端部署。[Studio 免费说明](https://docs.langchain.com/oss/python/langgraph/studio)、[官方价格页](https://www.langchain.com/pricing)。

`npm run studio` 关闭 LangSmith tracing 和 CLI 使用统计；不要在 `.env` 里开启 LANGSMITH_TRACING 或 LANGCHAIN_TRACING_V2。开发服务只监听本机，运行记录保存在 `.langgraph_api/`，已加入 Git 忽略。模型调用仍会把输入和召回样例发送给你配置的模型服务商。网页由 LangSmith 提供，读取连接到本地服务的图与状态。

## 第一次怎么操作

1. 登录后打开上述 Studio 链接，确认连接地址是 `http://127.0.0.1:2024`。
2. 选择 `intent_router`，使用 Graph 模式。
3. 创建新 Thread，在输入区域切到 JSON，粘贴以下完整初始状态：

```json
{
  "messages": [{"role": "user", "content": "查看 demo_budget_job 昨天的失败日志"}],
  "question": "查看 demo_budget_job 昨天的失败日志",
  "rewrite_count": 0,
  "retrieval": {},
  "grade": {},
  "result": {},
  "trace": [],
  "model_usage": []
}
```

4. 点击 Submit，观察实际经过的节点；是否检索由模型决定，并非每题都执行检索。
5. 点击节点看消息、工具参数、`retrieval`、`grade`、`result` 和 `trace`。最终的 `result.route` 应为 `daily-check`，这表示选择排查 Skill，并没有实际读取 Airflow 日志。

这里 `messages` 是模型对话输入，`question` 是供评判和最终分类使用的原始问题，两处应一致。当前先按单次意图分类调试：每个独立测试创建新 Thread，并重置上述初始字段。不要把它当主网页的连续业务对话入口。

## 和现有项目怎么关联

```text
现有网页 → TS Gateway → Python router.classify_rag()
                                ↓
                     build_intent_graph()
                                ↑
Studio → 本地 Agent Server → studio.make_graph()
```

两条入口复用同一份 `intent_graph.py`、MiniLM 检索、样例和路由定义。Studio 不会自动显示原网页的历史运行；两边运行记录分开保存。此入口只提供意图样例检索，不暴露 Airflow、DI、GSheet 或业务写入工具。

导出配置在 `langgraph.json`，图工厂在 `python/agent_backend/studio.py`。Studio 开发依赖单独放在 `python/requirements-studio.txt`。

## 断点调试

如需同时进入 Python 函数内部，可用官方参数启动：

```bash
npm run studio -- --debug-port 5678
```

该参数要求环境安装 debugpy；在 IDE 连接本机 5678 端口。Studio 展示节点状态，IDE 用于逐行查看函数变量。

## 浏览器连接

如 API 能访问而 Studio 持续加载，优先用 Chrome 打开上述链接。Safari / WebKit 对 HTTPS 网页连接 HTTP 本地服务有限制；官方列出 Chrome 作为替代方案。Chrome 如弹出本地网络访问许可，需要允许本站访问本机服务。不要为排查而直接把开发服务器开放到公网。[官方排查说明](https://docs.langchain.com/langsmith/troubleshooting-studio)。

## 本次验证

2026-10-20：本地 `/ok` 返回正常，图 API 返回完整节点；通过 Agent Server 实际运行合成问题「查看 demo_budget_job 昨天的失败日志」，经过决策、检索、评判和最终分类，得到 daily-check，未调用业务工具。5 个意图图回归测试通过，Studio 安装依赖解析检查通过。测试 Thread 与结果保存在 `.data/evaluation/studio-smoke.json`。内置浏览器画布持续加载，改用 Chrome 后实际显示 intent_router 的全部节点和条件边，截图为 `.data/studio-connected.png`。页面的「缺少 LANGSMITH_API_KEY」提示对应云端运行记录；此次未开启该功能。

参考：[Studio 官方接入说明](https://docs.langchain.com/langsmith/quick-start-studio)。
