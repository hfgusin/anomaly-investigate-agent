# mirror_read：与 `src/` 对照的 Python 阅读版

**用途**：把 TypeScript 网关/协议/限流等逻辑用 Python + 中文注释写出来，方便对照 `src/*.ts` 阅读。  
**不是**替代入口：启动服务仍用 `pnpm dev`（编译后的 `dist/server.js`）。

## 怎么对照看

| 你想懂什么 | 先看 Python | 再打开 TypeScript |
|------------|-------------|-------------------|
| WebSocket 请求 JSON 长什么样 | `protocol.py` | `src/protocol.ts` |
| 工具要不要人工审批 | `tool_policy.py` | `src/tool-policy.ts` |
| 网关/模型限流 | `rate_limit.py` | `src/rate-limit.ts` |
| `.env` 怎么选 runtime | `config_read.py` | `src/config.ts` |
| Node 怎么拉起 Python 模型循环 | `langchain_bridge.py` | `src/providers/langchain.ts` |
| 模型循环本体（你已在看的） | `python/agent_backend/runtime.py` | 无 TS 版（逻辑在 Python） |
| 全目录文件索引 | 仓库根 `docs/src-Python可读对照.md` | `src/` 各文件 |

本地可跑的小检查（不启动服务）：

```bash
cd python && python3 -m mirror_read.smoke
```
