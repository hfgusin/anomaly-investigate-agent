# 网页主 Agent 的动态 DI 查询

debug_agent 与网页使用同一个 `agent_backend.runtime`。Python DI 工具统一由 `agent_backend.tools.TOOLS` 注册，都是 LangChain @tool 对象。

## 网页使用

重启服务，打开原来的 18789 页面，点击商品成长分析，可以直接输入中文需求或粘贴单条只读 SQL。不需要先运行 debug_agent。

1. 中文单表查询：模型使用 di_export_table，返回预览及完整 CSV。
2. 用户提供 SQL、JOIN、CTE 等：模型使用 di_query_sql；字段不确定时先执行 `SELECT * FROM db.table WHERE 1=0`，读取真实 columns，再提交查询。
3. 每次工具调用都在网页等待你审批，审批卡会显示参数或完整 SQL。
4. SQL 成功后，网页显示预览、SQL、session_id、statement_id；returned_rows 不是全量总数，不生成或编造 CSV 链接。
5. 提交失败或超时先核对查询记录，不能自动重提。

主链路：RunCoordinator 选择 Growth Skill → ToolRegistry 提供两种 DI 工具 → LangChainRuntime 将 start 请求传给 Python → Python 注册表提供 @tool → LangChain create_agent / ToolNode → Gateway 审批 → Python handler 执行工具函数 → 结果回填模型和网页。

与 debug 的对应关系：messages 由 SQLite 会话历史组装；toolDefinitions 来自工具目录、activeToolNames 选择 DI 工具对；skillInstruction 来自当前 Skill 快照与主题路由；hostedSearch=false、toolResultMode=standard、工具结果预留最多32768字符。主页面保留自己的审批与会话管理。

## 本次修改

- debug 和主 Python Runtime 共享同一 DI 工具注册表。
- TS 从 Python catalog 读取 DI schema，审批允许列表由该工具目录生成。
- 网页补充 di_query_sql 审批文案、SQL 预览表、SQL 与查询编号；与 CSV 导出结果分别显示。

## 验证边界

编译通过；查询链路的 17 项 Node 和 19 项 Python 专项测试通过，SQL 卡片通过受控 DOM 检查。未执行你的生产 SQL。线上数值、表权限与会话状态仍需要你批准实际查询后验证。

整套 Python 测试尚未全部通过：旧 Growth 范围用例仍要求拒绝主题外表等请求，但当前 `di_models.py` 中的主题校验已经被注释。本次保留当前动态查询策略，没有重新启用该限制，不能把专项通过说成全套通过。
