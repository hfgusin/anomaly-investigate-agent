"""从这里开始写自己的工具；函数内可以调用你的服务、查询或业务代码。"""
from langchain_core.tools import tool


@tool
def greet_user(name: str) -> str:
    """按用户提供的姓名生成问候，用于验证 Python 工具执行链。"""
    # 在这里打断点：网页批准后会进入这个 Python 函数。
    return f"你好，{name}！这条结果来自 Python 工具。"
