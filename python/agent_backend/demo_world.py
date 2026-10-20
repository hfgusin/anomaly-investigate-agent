"""虚构的外部环境，用于评测和离线演示：在网络与子进程边界替换 Airflow、源码映射、Data API、DI 和 GSheet。

工具代码不变，只把它们访问的服务换成 world 文件里的数据。格式见 portfolio/evaluation/README.md。
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
import tempfile
from unittest.mock import patch
from urllib.parse import unquote

import httpx

SERVER_ROOT = "/home/toc/SSE"
AIRFLOW_URL = "https://airflow.demo"


def _page(items: list, key: str, params) -> httpx.Response:
    offset, limit = int(params.get("offset", 0)), int(params.get("limit", 100))
    return httpx.Response(200, json={key: items[offset:offset + limit], "total_entries": len(items)})


def _within(value: str | None, params) -> bool:
    if not value:
        return False
    moment = datetime.fromisoformat(value)
    lower, upper = params.get("start_date_gte"), params.get("start_date_lte")
    return (not lower or moment >= datetime.fromisoformat(lower)) and (not upper or moment <= datetime.fromisoformat(upper))


def airflow_handler(spec: dict):
    dags, tasks, logs = spec.get("dags", []), spec.get("task_instances", []), spec.get("logs", {})

    def respond(request: httpx.Request) -> httpx.Response:
        if spec.get("status"):
            return httpx.Response(spec["status"], json={"title": "Unauthorized"})
        parts = [unquote(p) for p in request.url.raw_path.decode().split("?")[0].split("/")[3:]]
        params = request.url.params
        if parts == ["dags"]:
            return _page(dags, "dags", params)
        dag = next((d for d in dags if d["dag_id"] == parts[1]), None)
        if len(parts) == 2:
            return httpx.Response(200, json=dag) if dag else httpx.Response(404)
        selected = [t for t in tasks if parts[1] in ("~", t["dag_id"])]
        if len(parts) >= 4 and parts[3] != "~":
            selected = [t for t in selected if t["dag_run_id"] == parts[3]]
        runs = {}
        for t in selected:
            run = runs.setdefault(t["dag_run_id"], {"dag_id": t["dag_id"], "dag_run_id": t["dag_run_id"], "state": "success",
                                                    "start_date": t.get("start_date"), "execution_date": t.get("execution_date")})
            if t["state"] == "failed":
                run["state"] = "failed"
        if len(parts) == 3:
            return _page(sorted(runs.values(), key=lambda r: r["start_date"] or "", reverse=True), "dag_runs", params)
        if len(parts) == 4:
            return httpx.Response(200, json=next(iter(runs.values()))) if runs else httpx.Response(404)
        if len(parts) == 5:
            if params.get("state"):
                selected = [t for t in selected if t["state"] == params["state"]]
            if "start_date_gte" in params:
                selected = [t for t in selected if _within(t.get("start_date"), params)]
            return _page(selected, "task_instances", params)
        task = next((t for t in selected if t["task_id"] == parts[5]), None)
        if len(parts) == 6:
            return httpx.Response(200, json=task) if task else httpx.Response(404)
        text = logs.get(f"{parts[1]}/{parts[3]}/{parts[5]}/{parts[7]}")
        return httpx.Response(200, text=text) if text is not None else httpx.Response(404)

    return respond


def dataservice_runner(apis: dict):
    def run(command, **_kwargs):
        action, args = command[3], command[4:]
        if action == "detail":
            api = apis.get(f"{args[0]}@{args[2]}")
            result = {"apiAbbr": args[0], "version": args[2], "copy": args[4], **api} if api else None
        elif action == "versions":
            result = {"items": [{"version": key.split("@")[1], **{k: v for k, v in api.items() if k != "code"}}
                                for key, api in apis.items() if key.split("@")[0] == args[0]]}
        else:
            result = {"items": [{"apiAbbr": key.split("@")[0]} for key in apis if args[1] in key], "total": len(apis)}
        if result is None:
            envelope = {"ok": False, "error": {"type": "not_found"}}
            return subprocess.CompletedProcess(command, 4, "", json.dumps(envelope))
        envelope = {"ok": True, "identity": "yara.huang@shopee.com", "data": {"result": result}, "meta": {"trace_id": "demo"}}
        return subprocess.CompletedProcess(command, 0, json.dumps(envelope), "")
    return run


def di_runner(queries: list[dict]):
    def run(request: dict) -> dict:
        sql = request.get("sql") or ""
        for query in queries:
            if all(re.search(pattern, sql, re.IGNORECASE | re.DOTALL) for pattern in query["match"]):
                rows = query["rows"]
                return {"state": "completed", "result_kind": "sql", "columns": query["columns"], "preview_rows": rows[:20],
                        "returned_rows": len(rows), "truncated": len(rows) > 20, "session_id": "demo", "statement_id": 1, "sql": sql}
        return {"state": "failed", "error": "演示环境没有预置这条查询的结果；请换一个更小、更直接的验证查询。", "sql": sql}
    return run


def gsheet_get(tabs: dict):
    def get(url, **_kwargs):
        target = unquote(url.split("/values/")[1])
        tab, cells = target.rsplit("!", 1)
        tab = tab.strip("'").replace("''", "'")
        if tab not in tabs:
            return httpx.Response(400, request=httpx.Request("GET", url))
        first, last = re.findall(r"\d+", cells)[:2]
        return httpx.Response(200, json={"values": tabs[tab][int(first) - 1:int(last)]}, request=httpx.Request("GET", url))
    return get


@contextmanager
def installed(spec: dict):
    import di_export
    from .tools import airflow, airflow_scan, check_records, dataservice, gsheet, project_source

    with ExitStack() as stack, tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for server_path, content in spec.get("sources", {}).items():
            path = root / "src" / server_path.removeprefix(SERVER_ROOT + "/")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        mapping = root / "source-roots.json"
        mapping.write_text(json.dumps({"mappings": [{"server_root": SERVER_ROOT, "local_root": str(root / "src")}]}))
        client = airflow.AirflowClient(AIRFLOW_URL, token="demo", transport=httpx.MockTransport(airflow_handler(spec.get("airflow", {}))))
        stack.enter_context(patch.dict("os.environ", {"AIRFLOW_BASE_URL": AIRFLOW_URL, "AUTOMATION_AIRFLOW_BASE_URL": AIRFLOW_URL,
                                                     "DI_IDENTITY": "yara.huang"}))
        stack.enter_context(patch.object(airflow, "_client", return_value=client))
        stack.enter_context(patch.object(airflow_scan, "_client", return_value=client))
        stack.enter_context(patch.object(project_source, "CONFIG", mapping))
        stack.enter_context(patch.object(dataservice.subprocess, "run", side_effect=dataservice_runner(spec.get("data_apis", {}))))
        stack.enter_context(patch.object(di_export, "run", side_effect=di_runner(spec.get("di_queries", []))))
        stack.enter_context(patch.object(gsheet, "gsheet_token", return_value="demo"))
        stack.enter_context(patch.object(gsheet.httpx, "get", side_effect=gsheet_get(spec.get("gsheets", {}))))
        stack.enter_context(patch.object(check_records, "DATABASE", root / "records.sqlite"))
        stack.enter_context(patch.object(check_records, "gsheet_token", return_value="demo"))
        stack.enter_context(patch.object(check_records, "_sync", return_value={"spreadsheet_id": "demo", "sheet_name": "Sheet1", "row": 2}))
        yield


def load(path: str) -> dict:
    return json.loads(Path(path).read_text())
