"""Read SQL through DI's own orchestration; do not start a CSV export."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from di_models import RawSQLRequest

ROOT = Path(__file__).resolve().parents[1]


def run_sql(parameters):
    request = RawSQLRequest.model_validate(parameters)
    executable = os.environ.get("DI_BIN") or str(Path.home() / ".local/bin/di")
    # +sql manages curated sessions itself. DI_SESSION_ID belongs to the export
    # path and may be expired or refer to a PySpark rather than SQL session.
    arguments = [executable, "livy", "+sql", "--sql", request.sql,
                 "--service-env", "sg", "--format", "json", "--timeout", "300s"]
    session_id = os.environ.get("DI_SQL_SESSION_ID", "")
    if session_id:
        if not session_id.isdecimal():
            raise ValueError("DI_SQL_SESSION_ID 必须是数字。")
        arguments.extend(["--session-id", session_id])
    else:
        arguments.extend(["--queue", os.environ.get("DI_QUEUE", "cnfashionbi-dev")])
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            process = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=stdout,
                                     stderr=stderr, cwd=ROOT, timeout=330)
        except subprocess.TimeoutExpired:
            return {"state": "unknown", "sql": request.sql,
                    "error": "DI 等待超时；远端可能已提交，请核对 DI 查询记录，不要重复提交。"}
        stream = stdout if process.returncode == 0 else stderr
        if stream.tell() > 16 * 1024 * 1024:
            raise ValueError("DI 响应过大；请缩小查询结果范围。原查询不要自动重提。")
        stream.seek(0)
        content = stream.read().decode("utf-8")
        try:
            envelope = json.loads(content)
        except ValueError:
            # +sql writes progress before its final error envelope to stderr.
            envelope = None
            for line in reversed(content.splitlines()):
                try:
                    candidate = json.loads(line)
                except ValueError:
                    continue
                if isinstance(candidate, dict) and "ok" in candidate:
                    envelope = candidate
                    break
            if envelope is None:
                raise ValueError("DI 未返回有效 JSON；请核对原查询，不要自动重提。") from None
    expected = os.environ.get("DI_IDENTITY", "yara.huang").removesuffix("@shopee.com")
    identity = envelope.get("identity")
    if identity is not None and identity not in (expected, expected + "@shopee.com"):
        raise ValueError("DI 身份不匹配；请核对原查询，不要自动重提。")
    if process.returncode or not envelope.get("ok"):
        error = envelope.get("error") or {}
        detail = error.get("detail") or {}
        if session_id and detail.get("status") == 404 and detail.get("operation_id") == "getInteractiveSession":
            # The statement never reached an expired session, so a fresh session cannot double-submit.
            os.environ.pop("DI_SQL_SESSION_ID", None)
            return run_sql(parameters)
        return {"state": "unknown", "sql": request.sql,
                "error": f"DI 查询未确认成功（{error.get('type', 'unknown')}）；核对原查询，不要自动重提。",
                "recovery": error.get("detail"), "trace_id": envelope.get("meta", {}).get("trace_id")}
    if identity is None:
        raise ValueError("DI 成功响应缺少身份；请核对原查询。")
    data = envelope["data"]
    result = data.get("result", data)
    statements = result["statements"]
    if len(statements) != 1 or statements[0].get("state") != "available" or statements[0].get("output", {}).get("status") != "ok":
        raise ValueError("DI 没有返回一条成功的 SQL 结果。")
    statement = statements[0]
    bundle = statement["output"]["data"]["application/json"]
    schema = bundle["schema"]
    fields = schema["fields"] if isinstance(schema, dict) else schema
    rows = bundle["data"]
    # Debug's following turns reuse the created SQL session instead of using
    # another quota slot. Separate CLI processes can set DI_SQL_SESSION_ID.
    os.environ["DI_SQL_SESSION_ID"] = str(result["session"]["sessionId"])
    preview = []
    budget = 10000
    for row in rows[:20]:
        cells = [cell[:500] if isinstance(cell, str) else cell for cell in row]
        size = len(json.dumps(cells, ensure_ascii=False))
        if size > budget:
            break
        preview.append(cells)
        budget -= size
    return {"state": "completed", "sql": request.sql, "result_kind": "sql",
            "columns": [field["name"] for field in fields], "preview_rows": preview,
            "returned_rows": len(rows), "preview_truncated": True,
            "completeness_verified": False, "session_id": result["session"]["sessionId"],
            "statement_id": statement["statementId"],
            "trace_id": envelope.get("meta", {}).get("trace_id"),
            "note": "直接读取 DI SQL 结果，不导出 CSV。DI 结果可能截断，预览不能代表全量；returned_rows 不是总行数。"}
