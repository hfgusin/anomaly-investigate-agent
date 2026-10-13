# 方舟 Responses 接入

对应用户给出的 `/api/v3/responses` 请求。项目原 Chat Completions 适配器保留，新模式 `MIRROR_RUNTIME=responses` 使用 `src/providers/responses.ts`。

## 配置

```dotenv
MIRROR_RUNTIME=responses
MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
MODEL_NAME=deepseek-v4-1-flash-260910
MODEL_API_KEY=填写新的方舟密钥
RESPONSES_WEB_SEARCH=true
RESPONSES_MAX_KEYWORD=3
```

本次已修改本机非密钥配置；没有复制聊天中暴露的密钥，没有请求该密钥。请撤销聊天中暴露的密钥，新密钥只放 `.env`。Base URL 可以是 API 根地址或完整 `/responses` 地址。`MODEL_TOOL_RESULT_MODE` 仅用于 Chat Completions，新模式采用标准 Responses 函数回填。

未设置 thinking 时使用模型默认；可选 `MODEL_THINKING=enabled/disabled`。需要实际模型支持；本次没有未经验证地默认关闭。Search 不保证免费，费用和权限由方舟服务决定。

## 实现

- `input` 转换为 Responses 消息格式；`stream: true`、`store: false`。输入历史来自本机 SQLite，不依赖服务端 previous_response_id。
- 解析 SSE 的 output_text.delta、output_item.done、completed，保持 UTF-8 跨块正确；缺少成功完成事件、服务端失败和异常断流明确失败，保留部分输出。
- 普通聊天提供 `web_search`，max_keyword=3。显式 Skill、Agent 指令和记忆摘要关闭服务端搜索，保留原来工具范围。
- 自定义函数转换为 Responses function schema；接收 function_call、经现有审批执行，再回填 function_call_output，最多 8 轮 / 16 个函数调用。HTTP 名额在工具等待前释放。
- web_search_call 保存查询与状态；url_citation 保存标题与 HTTP(S) 链接。写入 Run 的 providerTrace 和步骤事件，页面可展示并刷新恢复。引用只表示服务商返回的出处，不代表本地 fetch_url 精读，也不证明结论正确。
- 搜索是服务端自动执行，不是本地请求审批。可以在配置关闭。max_keyword 不是总调用次数或费用硬上限；没有宣称跨强杀搜索 exactly-once。
- 限流、取消信号、错误密钥保护复用现有规则；不记录 HTTP 错误正文或原始传输异常。

## 页面验收

1. 更新本地新密钥，原终端 Ctrl+C，运行 `pnpm dev`，刷新页面。
2. 顶部应显示新模型和“联网搜索已启用”。新建会话提问：`请联网查询今天的热点新闻，注明新闻发生日期和来源。`
3. 若服务商实际搜索，回答下应有真实查询记录和来源链接。仅回答“我搜索了”不能算成功。
4. 再用你的陌生书名问题，观察搜索后是否确认作品或解释歧义。找到来源不意味着模型一定识别正确。
5. 文件工具另测：`读取 agent_demo.txt，告诉我项目代号。` 应仍先请求本地审批；拒绝时不得执行读取。
6. 生成中停止，确认未标记完成；刷新后已有查询/引用保留。Responses 使用已有单次运行截止时间，超时会明确失败。

当前构建与受控测试已通过；没有使用暴露密钥做真实模型调用，用户真实网页验收待进行。接口字段参考方舟官方 [Responses API](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh) 与 [流式输出](https://docs.volcengine.com/docs/ark/streaming-output?lang=zh)。

## HTTP 400 与账号搜索权限排查

后续使用本地配置接口实测：无历史请求 HTTP 200；助手历史使用紧凑消息加 output_text 时返回 HTTP 400 / MissingParameter / input.type；改成 input_text 后 HTTP 200。适配器已修复，本地历史不会伪装为完整模型 output item。

联网请求已到达服务商，但服务商返回 ToolNotOpen：账号尚未激活 web search。界面现在映射为 WEB_SEARCH_NOT_ACTIVATED，并给出服务商提供的开通地址 https://console.volcengine.com/common-buy/CC_content_plugin 。搜索动作记录不等于已取得网页结果；该次失败不算联网成功。是否开通及其费用由用户在控制台确认。
