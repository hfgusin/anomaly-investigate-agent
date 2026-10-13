# 从一条消息读到运行结果

当前这一阶段可以沿 5 个入口读懂，不需要先看完整目录。

1. 浏览器在 `public/app.js` 发送 `chat.send`，带上会话 ID、用户内容和稳定的 `clientRequestId`。连接中断后重发同一内容会继续用这个编号。
2. `src/gateway.ts` 校验参数，把请求交给 `RunCoordinator.accept()`。每次状态变化会广播给已连接的本机客户端。
3. `src/session-store.ts` 在事务中写入 queued 运行，之后才向浏览器确认接收。这里保存的是运行本身，不依赖浏览器还开着。
4. `src/run-coordinator.ts` 等同会话的前一次运行结束，再读取上下文，调 Runtime，逐块保存输出。完成、取消、失败、超时都必须落到明确终态。
5. 浏览器按 `sessionId + generation` 筛选运行，按 `version` 合并新旧状态。刷新则重新读取 SQLite 快照，不依赖丢失的网络事件。

## 运行中发送新消息：引导而非普通排队

当已有回答正在生成时，浏览器改发 `chat.steer`，其中包含正在运行的 `runId` 和可重试的 `clientRequestId`。`Gateway` 把它交给 `RunCoordinator.steer()`；`SessionStore` 先把引导文本写入该 Run 的 `steerTrace`，再取消当前模型请求。

OpenClaw 的运行时可以把内容注入活跃 Agent。标准 Chat Completions 的单条 HTTP 流不能在半路添加用户消息，因此本项目使用明确的适配：取消该次模型请求，清除它的临时输出，以“原问题 + 所有已接收引导”重新请求模型。Run ID、工具记录和审计记录不变，页面也不会额外新增一条用户回合。相同 `clientRequestId` 到达两次时，数据库返回已有记录，不会重复注入。

## 第一个值得一起讨论的实现

假设你在第一条还没回答完时，连续发了两条：

```text
第一条：给我三个项目名称。
第二条：用第二个名称写一句介绍。
```

如果第二条在“收到请求时”就保存上下文快照，它读不到第一条尚未生成的回答。我们的实现把上下文读取放在队列开始执行时，因此第二条会读到第一条已经提交的完整回答，同时通过运行位置限制排除排在它后面的用户输入。

对应代码：`RunCoordinator.execute()` → `SessionStore.contextFor()`。对应回归：`tests/runtime.test.mjs` 中的 queued-context 场景。

## 下一段一起做什么

工具循环已接通：模型流中的 `tool_calls` 由 `src/providers/chat-completions.ts` 拼好参数，经 `RunCoordinator` 记入运行记录，再由 `src/tools/read-file.ts` 的 `read_file` 或 `search_workspace` 限定在 `workspace/` 目录内执行。结果作为 `tool` 消息回填，模型继续生成；模拟服务商与真实接口场景已验证。

上下文预算与会话内 Memory 已接入：`SessionStore.contextFor()` 挑选连续的最新轮次并建立历史快照；`RunCoordinator` 对新快照尝试摘要，失败时使用摘录，且持久化状态供中断后重试。运行记录显示消息、系统提示、输出和工具结果的字符预算。真实接口验证脚本在 `scripts/qa-memory-live.mjs`。当前接口仍使用 `plain` 工具结果回填模式；这条兼容分支可从 `src/providers/chat-completions.ts` 开始看。
