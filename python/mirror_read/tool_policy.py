"""
对应：src/tool-policy.ts

RunCoordinator 用 has_side_effect 决定工具是否要用户点「批准」才执行。
"""
from __future__ import annotations

from typing import Literal

ToolRisk = Literal["read", "network_read", "write", "execute", "delegate", "unknown"]


def tool_risk(name: str) -> ToolRisk:
    if name in (
        "read_file", "search_workspace", "list_workspace", "research_hotpot",
        "search_passages", "open_passage", "automation_report",
    ):
        return "read"
    if name == "delegate_task":
        return "delegate"
    if name in ("fetch_url", "di_export_table", "di_query_sql") or name.startswith("airflow_"):
        return "network_read"
    if name == "write_file":
        return "write"
    if name == "run_javascript":
        return "execute"
    return "unknown"


def has_side_effect(name: str) -> bool:
    return tool_risk(name) in ("write", "execute")
