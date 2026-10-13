"""事后留底：先存本地 SQLite，再同步固定 GSheet；同一失败实例始终更新同一行。"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from langchain_core.tools import ToolException, tool
from pydantic import BaseModel, Field

from ..gsheet_auth import gsheet_token
from ..paths import DATA_DIR, ROOT

DATABASE = DATA_DIR / "automation-checks.sqlite"
HEADERS = ["记录ID", "检查时间", "服务器", "DAG", "运行ID", "任务ID", "映射编号", "尝试编号",
           "错误摘要", "已确认事实", "待验证假设", "证据", "处理建议", "处理状态", "覆盖情况", "更新时间"]


class CheckRecordInput(BaseModel):
    server: Literal["default", "automation"]
    dag_id: str = Field(min_length=1, max_length=200)
    dag_run_id: str = Field(min_length=1, max_length=300)
    task_id: str = Field(min_length=1, max_length=200)
    try_number: int = Field(ge=1)
    error_summary: str = Field(min_length=1, max_length=500)
    facts: str = Field(max_length=1500)
    hypotheses: str = Field(max_length=1000)
    evidence: list[Annotated[str, Field(max_length=500)]] = Field(max_length=10, description="证据来源，如日志 URL、源码行、SQL sha256；不要粘贴原始日志")
    suggestions: str = Field(max_length=1000)
    coverage: str = Field(max_length=500)
    map_index: int = Field(default=-1, ge=-1)
    status: Literal["待确认", "待处理", "已解决"] = "待确认"


@contextmanager
def _db():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DATABASE, timeout=35)
    db.execute("CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload TEXT NOT NULL, sync_status TEXT NOT NULL, sync_error TEXT)")
    try:
        with db:
            yield db
    finally:
        db.close()


def _row(record: dict) -> list:
    return [record["record_id"], record["checked_at"], record["server"], record["dag_id"], record["dag_run_id"],
            record["task_id"], record["map_index"], record["try_number"], record["error_summary"], record["facts"],
            record["hypotheses"], "\n".join(record["evidence"]), record["suggestions"], record["status"],
            record["coverage"], record["updated_at"]]


def _sync(record: dict, token: str) -> dict:
    config = json.loads((ROOT / "config/check-records.json").read_text())
    sheet = "'" + config["sheet_name"].replace("'", "''") + "'"

    def values(range_: str) -> str:
        return "values/" + quote(f"{sheet}!{range_}", safe="")

    base = f"https://sheets.googleapis.com/v4/spreadsheets/{config['spreadsheet_id']}/"
    with httpx.Client(base_url=base, headers={"Authorization": f"Bearer {token}"}, timeout=15) as http:
        def call(method: str, path: str, **kwargs) -> dict:
            response = http.request(method, path, **kwargs)
            if response.is_error:
                raise ToolException(f"GSheet HTTP {response.status_code}")
            return response.json()

        if call("GET", values("A1:P1")).get("values") != [HEADERS]:
            raise ToolException(f"表头与记录格式不一致，未写入；检查 {config['sheet_name']}!A1:P1。")
        ids = [row[0] if row else "" for row in call("GET", values("A2:A")).get("values", [])]
        body, params = {"values": [_row(record)]}, {"valueInputOption": "RAW"}
        if record["record_id"] in ids:
            row = ids.index(record["record_id"]) + 2
            call("PUT", values(f"A{row}:P{row}"), params=params, json=body)
        else:
            row = None
            call("POST", values("A:P") + ":append", params={**params, "insertDataOption": "INSERT_ROWS"}, json=body)
    return {"spreadsheet_id": config["spreadsheet_id"], "sheet_name": config["sheet_name"], "row": row}


@tool(args_schema=CheckRecordInput)
def record_automation_check(server: str, dag_id: str, dag_run_id: str, task_id: str, try_number: int,
                            error_summary: str, facts: str, hypotheses: str, evidence: list[str], suggestions: str,
                            coverage: str, map_index: int = -1, status: str = "待确认") -> dict:
    """排查结束后留底：先存本机，再同步固定 GSheet。同一服务器/运行/任务/映射/尝试始终更新同一行，同步失败时用相同参数再调用一次即可重试。事实与假设分开写，证据写工具返回的来源。不修改 Airflow、SQL 或广告。"""
    record_id = hashlib.sha256(json.dumps([server, dag_id, dag_run_id, task_id, map_index, try_number]).encode()).hexdigest()[:32]
    now = datetime.now(timezone.utc).isoformat()
    record = dict(server=server, dag_id=dag_id, dag_run_id=dag_run_id, task_id=task_id, try_number=try_number,
                  error_summary=error_summary, facts=facts, hypotheses=hypotheses, evidence=evidence,
                  suggestions=suggestions, coverage=coverage, map_index=map_index, status=status,
                  record_id=record_id, checked_at=now, updated_at=now)
    with _db() as db:
        previous = db.execute("SELECT payload FROM records WHERE id=?", (record_id,)).fetchone()
        if previous:
            record["checked_at"] = json.loads(previous[0])["checked_at"]
        db.execute("INSERT INTO records VALUES (?, ?, 'pending', NULL) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, sync_status='pending', sync_error=NULL",
                   (record_id, json.dumps(record, ensure_ascii=False)))
    result = {"record_id": record_id, "record_saved": True, "updated": bool(previous), "local_path": str(DATABASE)}
    try:
        location = _sync(record, gsheet_token())
    except (ToolException, httpx.HTTPError, OSError, ValueError, KeyError) as exc:
        error = str(exc) if isinstance(exc, ToolException) else f"GSheet 同步失败（{type(exc).__name__}）"
        with _db() as db:
            db.execute("UPDATE records SET sync_error=? WHERE id=?", (error, record_id))
        return {**result, "sync_status": "pending", "sync_error": error + "；本地记录已保存，用相同参数再调用即可重试。"}
    with _db() as db:
        db.execute("UPDATE records SET sync_status='synced' WHERE id=?", (record_id,))
    return {**result, "sync_status": "synced", **location}


record_automation_check.handle_tool_error = True
