from langchain_core.tools import ToolException, tool


@tool
def send_message(message: str) -> str:
    """模拟发送消息的工具函数。"""
    # 在这里打断点：网页批准后会进入这个 Python 函数。
    if not message:
        raise ToolException("消息不能为空。")
    # 模拟发送消息的逻辑
    return f"消息已发送: {message}"