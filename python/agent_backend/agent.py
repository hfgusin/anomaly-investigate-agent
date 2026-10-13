"""Agent 构建入口：需要添加自己的流程逻辑时，从这里开始。"""
from langchain.agents import create_agent

# 添加自定义 LangChain AgentMiddleware 实例，例如记录业务状态或调整 prompt。
# 不需要自定义逻辑时保持空列表；无需重写模型/工具循环。
BUSINESS_MIDDLEWARE = []


def build_agent(model, tools, system_prompt, gateway_middleware=None, context_schema=None):
    return create_agent(
        model=model,
        tools=tools,
        system_prompt=system_prompt,
        middleware=([gateway_middleware] if gateway_middleware is not None else []) + BUSINESS_MIDDLEWARE,
        context_schema=context_schema,
    )
