"""按 owner 和日期范围列出当前失败的任务实例；归因留给 Agent 后续逐个查证。"""
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.tools import ToolException, tool

from .airflow import TASK_FIELDS, AirflowClient, Server, _client, _pick


def _all(client: AirflowClient, segments: tuple[str, ...], key: str, params: dict | None = None) -> list[dict]:
    items, offset = [], 0
    while True:
        body = client.get(*segments, params={**(params or {}), "limit": 100, "offset": offset}).json()
        items += body[key]
        offset += len(body[key])
        if not body[key] or offset >= body["total_entries"]:
            return items


def _utc_range(start_date: str, end_date: str, time_zone: str) -> tuple[datetime, datetime]:
    try:
        zone = ZoneInfo(time_zone)
        first, last = date.fromisoformat(start_date), date.fromisoformat(end_date)
    except (ValueError, ZoneInfoNotFoundError):
        raise ToolException("日期须为 YYYY-MM-DD，时区须为 IANA 名称（如 Asia/Shanghai）。") from None
    if not 0 <= (last - first).days <= 30:
        raise ToolException("结束日期不能早于起始日期，范围最多 31 天。")
    lower = datetime.combine(first, time.min, zone).astimezone(timezone.utc)
    upper = datetime.combine(last + timedelta(days=1), time.min, zone).astimezone(timezone.utc)
    return lower, upper


@tool(parse_docstring=True)
def airflow_scan_failures(start_date: str, end_date: str, owner: str = "yara", server: Server = "automation",
                          time_zone: str = "Asia/Shanghai", dag_id: str | None = None) -> dict:
    """列出 owner 名下 DAG 在日期范围内当前状态为 failed 的任务实例，按任务开始时间筛选。

    重试后已成功的任务不算失败；upstream_failed 是上游失败的连带结果，不列出。

    Args:
        start_date: 起始日 YYYY-MM-DD，包含当天。
        end_date: 结束日 YYYY-MM-DD，包含当天；D-5 到 D0 共六天。
        owner: 与 DAG 的 owners 精确匹配，不按 DAG 名称猜作者。
        server: default 或 automation。
        time_zone: 日期所在时区。
        dag_id: 可选，只看这一个 DAG。
    """
    lower, upper = _utc_range(start_date, end_date, time_zone)
    client = _client(server)
    dags = [client.get("dags", dag_id).json()] if dag_id else _all(client, ("dags",), "dags")
    owned = sorted(dag["dag_id"] for dag in dags if owner in dag.get("owners", []))
    tasks = []
    if owned:
        tasks = _all(client, ("dags", dag_id or "~", "dagRuns", "~", "taskInstances"), "task_instances", {
            "state": "failed", "start_date_gte": lower.isoformat(),
            "start_date_lte": (upper - timedelta(microseconds=1)).isoformat()})
    failed = []
    for task in tasks:
        if task["dag_id"] not in owned:
            continue
        query = urlencode({"dag_run_id": task["dag_run_id"], "task_id": task["task_id"], "tab": "logs"})
        failed.append({**_pick(task, TASK_FIELDS), "execution_date": task.get("execution_date"),
                       "url": f"{client.root_url}/dags/{task['dag_id']}/grid?{query}"})
    return {"server": server, "owner": owner, "start_date": start_date, "end_date": end_date,
            "time_zone": time_zone, "owned_dags": owned, "failed_tasks": failed}


airflow_scan_failures.handle_tool_error = True
