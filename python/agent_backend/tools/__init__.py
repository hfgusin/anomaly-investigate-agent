"""业务工具唯一注册入口：写 @tool 函数，import，加入 TOOLS，再用 _describe 声明元数据。

元数据经 catalog 交给 TS：risk 决定审批与中断语义，skills 决定哪些 Skill 能看到它，
label 是网页审批卡的标题，auto_approve 只对 read / network_read 生效。
未声明的工具按 execute 处理，仍需网页审批。
"""
from ..di_tool import di_export_table, di_query_sql
from .example import greet_user
from .airflow import AIRFLOW_TOOLS, airflow_connection_info
from .airflow_scan import airflow_scan_failures
from .dataservice import DATASERVICE_TOOLS
from .project_source import read_project_source
from .check_records import record_automation_check
from .gsheet import read_gsheet_rows
from .business_sources import search_business_sources

TOOLS = [di_export_table, di_query_sql, *AIRFLOW_TOOLS, airflow_scan_failures,
         *DATASERVICE_TOOLS, read_project_source, read_gsheet_rows, search_business_sources,
         record_automation_check, greet_user]


def _describe(tools, risk, skills=(), label="", auto_approve=False, budget_group="query"):
    for item in tools:
        item.metadata = {"risk": risk, "skills": list(skills), "label": label,
                         "auto_approve": auto_approve, "budget_group": budget_group}


DAILY = "daily-check"
SOURCES = "source-lookup"
_describe([di_export_table], "network_read", ["growth"], "只读 DI 数据查询 · 请核对表、日期、筛选和聚合口径")
_describe([di_query_sql], "network_read", ["growth", DAILY, SOURCES], "只读 DI SQL 查询 · 请核对完整 SQL 和日期条件")
_describe([*AIRFLOW_TOOLS, airflow_scan_failures], "network_read", [DAILY], "查询 Airflow（只读，日志可保存本地）", auto_approve=True)
_describe([airflow_connection_info], "read", [DAILY], "查看本地 Airflow 连接配置", auto_approve=True)
_describe(DATASERVICE_TOOLS, "network_read", [DAILY], "读取 Data API 定义（不执行 SQL）", auto_approve=True)
_describe([read_project_source], "read", [DAILY, SOURCES], "读取映射的本地源码（不执行）", auto_approve=True)
_describe([search_business_sources], "read", [DAILY, SOURCES], "检索业务来源目录（只读）", auto_approve=True)
_describe([read_gsheet_rows], "network_read", [DAILY], "只读核对业务 GSheet 表头和样例", auto_approve=True)
_describe([record_automation_check], "write", [DAILY], "保存排查记录到本机并同步 GSheet（同一失败实例更新同一行）", budget_group="record")
_describe([greet_user], "read")


def tools_by_name():
    names = {tool.name: tool for tool in TOOLS}
    if len(names) != len(TOOLS):
        raise ValueError("Python 工具名称重复")
    return names


def tool_risk(name: str) -> str:
    tool = tools_by_name().get(name)
    return (tool.metadata or {}).get("risk", "execute") if tool else "execute"
