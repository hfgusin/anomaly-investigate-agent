"""TS 启动时读取此目录；schema 从 @tool 自动生成，元数据来自 tools/__init__.py，不在 TS 重复手写。"""
import json
from langchain_core.utils.function_calling import convert_to_openai_tool
from .tools import tools_by_name


def catalog():
    entries = []
    for tool in tools_by_name().values():  # 重名时启动失败。
        meta = tool.metadata or {}
        entries.append({"definition": convert_to_openai_tool(tool), "risk": meta.get("risk", "execute"),
                        "skills": meta.get("skills", []), "label": meta.get("label", ""),
                        "autoApprove": meta.get("auto_approve", False),
                        "budgetGroup": meta.get("budget_group", "query")})
    return entries


if __name__ == "__main__":
    print(json.dumps(catalog(), ensure_ascii=False))
