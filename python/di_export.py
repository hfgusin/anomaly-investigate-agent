"""DI read-only table export, with Pydantic request validation."""
import base64
import csv
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid
import zlib

from dotenv import dotenv_values
from pydantic import ValidationError
from di_models import REQUEST
from agent_backend.di_retry import DIRetryMiddleware, TransientDIError, is_safe_read

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / ".data" / "di-exports"
SESSION_PENDING_STATES = {"starting", "busy", "not_started", "recovering"}
SESSION_FAILED_STATES = {"error", "dead", "killed", "shutting_down", "success"}


class DICommandError(ValueError):
    def __init__(self, kind, status=None):
        self.kind = kind
        self.status = status
        super().__init__(f"DI 失败（{kind}{f'，HTTP {status}' if status else ''}）；核对登录、网络、权限及 session。")


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", value):
        raise ValueError("字段名只能包含字母、数字和下划线。")
    return "`" + value + "`"


def literal(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not float('-inf') < value < float('inf'):
            raise ValueError("筛选数字不合法。")
        return str(value)
    if not isinstance(value, str) or len(value) > 500 or re.search(r"[\\\x00-\x1f]", value):
        raise ValueError("筛选值必须是普通字符串或有限数字。")
    return "'" + value.replace("'", "''") + "'"


def build_sql(args):
    # 请求类型、字段范围和日期组合已经通过 Pydantic 校验。
    if args["action"] == "sql":
        return args["sql"], None
    table = args["table"]
    columns = args.get("columns")
    filters = args.get("filters", [])
    conditions = []
    for item in filters:
        conditions.append(f"{identifier(item['column'])} {item['operator']} {literal(item['value'])}")
    if args.get("latest_day"):
        col = identifier(args.get("date_column"))
        qualified = '.'.join(map(identifier, table.split('.')))
        inner_where = " WHERE " + " AND ".join(conditions) if conditions and args.get("latest_scope", "filtered") == "filtered" else ""
        latest_sql = f"SELECT MAX(CAST({col} AS DATE)) AS latest_day FROM {qualified}{inner_where}"
        conditions.append(f"CAST({col} AS DATE) = (SELECT MAX(CAST({col} AS DATE)) FROM {qualified}{inner_where})")
    else:
        latest_sql = None
    if any(key in args for key in ("start", "end")):
        start, end = args.get("start"), args.get("end")
        col = identifier(args.get("date_column"))
        conditions.extend([f"{col} >= {literal(start)}", f"{col} < {literal(end)}"])
    groups = args.get("group_by", [])
    metrics = args.get("metrics")
    fields = ", ".join(map(identifier, columns)) if columns else "*"
    if metrics:
        expressions = list(map(identifier, groups))
        for metric in metrics:
            column = identifier(metric["column"]) if metric.get("column") else "*"
            function = metric["function"]
            if function == "count":
                expression = f"COUNT({column})"
            elif function == "count_distinct":
                expression = f"COUNT(DISTINCT {column})"
            elif function in ("sum", "avg"):
                expression = f"{function.upper()}(CAST({column} AS DOUBLE))"
            else:
                denominator = f"SUM(CAST({identifier(metric['denominator'])} AS DOUBLE))"
                expression = f"CASE WHEN {denominator} = 0 THEN NULL ELSE SUM(CAST({column} AS DOUBLE)) / {denominator} END"
            expressions.append(f"{expression} AS {identifier(metric['alias'])}")
        fields = ", ".join(expressions)
    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    grouping = " GROUP BY " + ", ".join(map(identifier, groups)) if groups else ""
    ordering = " ORDER BY " + ", ".join(map(identifier, groups)) if groups else ""
    return f"SELECT {fields} FROM {'.'.join(map(identifier, table.split('.')))}{where}{grouping}{ordering}", latest_sql


def save(job):
    path = DIRECTORY / (job["id"] + ".json")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=DIRECTORY, delete=False) as file:
        json.dump(job, file, ensure_ascii=False, indent=2)
        temporary = file.name
    os.replace(temporary, path)


def command(args, job):
    return DIRetryMiddleware().invoke(lambda: command_once(args, job), args, job, save)


def command_once(args, job):
    executable = os.environ.get("DI_BIN") or str(Path.home() / ".local/bin/di")
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            process = subprocess.run([executable, *args, "--service-env", "sg"], stdin=subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr, timeout=10 if is_safe_read(args) else 30, cwd=ROOT)
        except subprocess.TimeoutExpired:
            if is_safe_read(args):
                raise TransientDIError("timeout") from None
            raise  # 提交超时：结果未知，不重试。
        stream = stdout if process.returncode == 0 else stderr
        if stream.tell() > 16 * 1024 * 1024:
            raise ValueError("DI 响应过大，缩小字段范围或行数后查询。")
        stream.seek(0)
        try:
            envelope = json.load(stream)
        except (ValueError, UnicodeDecodeError):
            raise ValueError("DI 未返回有效 JSON；未保存原始错误正文。")
    if envelope.get("_notice"):
        job["notices"].append(envelope["_notice"])
    expected = os.environ.get("DI_IDENTITY", "yara.huang")
    # 失败 envelope 可能没有 identity；若提供了，仍需匹配才能考虑重试。
    actual_identity = envelope.get("identity")
    identity_matches = actual_identity in (expected, expected.removesuffix("@shopee.com") + "@shopee.com")
    result = envelope.get("data", {}).get("result", {})
    if args[3:4] == ["execute"] and type(result.get("id")) is int:
        job["statement_id"] = result["id"]
        job.setdefault("statement_ids", []).append(result["id"])
    save(job)  # Preserve a submission ID even if validation fails afterward.
    if process.returncode or not envelope.get("ok"):
        kind = envelope.get("error", {}).get("type", "unknown")
        job["di_error"] = {"type": kind, "exit_code": process.returncode}
        if is_safe_read(args) and kind == "network" and (actual_identity is None or identity_matches):
            error = envelope.get("error") or {}
            delay = error.get("retry_after_ms", (error.get("detail") or {}).get("retry_after_ms", 0))
            if not isinstance(delay, (int, float)) or isinstance(delay, bool) or not 0 <= delay < float("inf"):
                delay = 0
            raise TransientDIError(kind, delay)
        status = (envelope.get("error", {}).get("detail") or {}).get("status")
        raise DICommandError(kind, status)
    if not identity_matches:
        raise ValueError("DI 身份不匹配；已保留查询编号，不自动重提。")
    job.pop("di_error", None)
    job.setdefault("trace_ids", []).append(envelope.get("meta", {}).get("trace_id"))
    return result


def session_owner_matches(session):
    expected = os.environ.get("DI_IDENTITY", "yara.huang").removesuffix("@shopee.com")
    return session.get("owner") == expected


def ensure_session(job):
    """Reuse an owned session, or create one after an approved query when it expired."""
    session = None
    expired_session_id = None
    session_id = str(job.get("session_id") or "")
    if session_id:
        try:
            session = command(["livy", "interactives", "get", session_id], job)
        except DICommandError as error:
            if error.kind != "api" or error.status != 404:
                raise
            expired_session_id = session_id
            job.pop("session_id", None)

    if session is None:
        queue = os.environ.get("DI_QUEUE", "cnfashionbi-dev")
        name = os.environ.get("DI_SESSION_NAME", "openclaw-mirror")
        session = command(["livy", "interactives", "create", "--kind", "pyspark",
                           "--queue", queue, "--name", name, "--yes"], job)
        identifier = session.get("id")
        if type(identifier) is not int:
            raise ValueError("DI 创建会话后未返回 session ID。")
        job["session_id"] = str(identifier)
        if expired_session_id:
            job.setdefault("notices", []).append(
                f"DI session {expired_session_id} 已过期，已创建新会话 {identifier}。")
        save(job)

    if not session_owner_matches(session):
        raise ValueError("session owner 不匹配。")
    job["application_id"] = session.get("appId") or session.get("applicationId")
    state = session.get("state")
    if state in SESSION_FAILED_STATES:
        raise ValueError(f"DI session 状态不可用：{state}。")
    if state in SESSION_PENDING_STATES:
        job["phase"] = "session"
        job["state"] = "submitted"
        save(job)
        return False
    return True


def csv_value(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, str) and re.match(r"^\s*[=+@-]", value):
        return "'" + value
    return value


MARKER = "DI_EXPORT_PACKET="
PAGE_SIZE = 2000  # Transport batch only, not an export row limit.


def remote_code(job):
    name = "_di_export_" + job["id"].replace("-", "")
    if job["phase"] == "prepare":
        latest = f"spark.sql({job['latest_sql']!r}).first()[0]" if job.get("latest_sql") else "None"
        # Resolve latest day once, so later pages cannot drift to another day.
        resolve_latest = ""
        if job.get("latest_sql"):
            clause = " = (" + job["latest_sql"] + ")"
            resolve_latest = f'''_source_sql = _source_sql.replace({clause!r}, " = NULL" if _latest is None else " = CAST('" + _latest + "' AS DATE)")'''
        return f"""import json as _di_json
from pyspark import StorageLevel as _di_storage
_latest_value = {latest}
_latest = str(_latest_value) if _latest_value is not None else None
_source_sql = {job['sql']!r}
{resolve_latest}
_df = spark.sql(_source_sql)
_base = _df.rdd.map(lambda r: list(r)).persist(_di_storage.DISK_ONLY)
_base_count = _base.count()
_indexed = _base.zipWithIndex().persist(_di_storage.DISK_ONLY)
_total = _indexed.count()
assert _total == _base_count
{name} = {{'base': _base, 'rdd': _indexed, 'columns': _df.columns, 'total': _total}}
print({MARKER!r} + _di_json.dumps({{'columns': _df.columns, 'total': _total, 'latest_day': _latest, 'spark_time_zone': spark.conf.get('spark.sql.session.timeZone')}}, default=str))
"""
    if job["phase"] == "page":
        start, end = job["offset"], min(job["offset"] + job["page_size"], job["expected_rows"])
        return f"""_page = sorted({name}['rdd'].filter(lambda x: {start} <= x[1] < {end}).collect(), key=lambda x: x[1])
assert [x[1] for x in _page] == list(range({start}, {end}))
import zlib as _di_zlib, base64 as _di_base64
_payload = _di_base64.b64encode(_di_zlib.compress(_di_json.dumps([x[0] for x in _page], default=str).encode('utf-8'))).decode('ascii')
print({MARKER!r} + _di_json.dumps({{'offset': {start}, 'payload': _payload}}))
"""
    return f"""{name}['rdd'].unpersist()
{name}['base'].unpersist()
del {name}
print({MARKER!r} + '{{"cleaned": true}}')
"""


def packet(statement):
    text = statement["output"]["data"].get("text/plain", "")
    lines = [line[len(MARKER):] for line in text.splitlines() if line.startswith(MARKER)]
    if len(lines) != 1:
        raise ValueError("该批次输出缺失或被 DI 截断，未认定全量导出成功。")
    try:
        data = json.loads(lines[0])
        if "payload" in data:
            inflater = zlib.decompressobj()
            content = inflater.decompress(base64.b64decode(data.pop("payload"), validate=True), 16*1024*1024+1)
            if len(content) > 16*1024*1024 or not inflater.eof:
                raise ValueError("该批次解压后过大或不完整，需缩小传输批次。")
            data["rows"] = json.loads(content)
        return data
    except (json.JSONDecodeError, zlib.error, UnicodeError) as error:
        raise ValueError("该批次输出被截断或损坏，未写入 CSV。")


def accept_packet(job, data):
    if job["phase"] == "prepare":
        if type(data.get("total")) is not int or data["total"] < 0 or not isinstance(data.get("columns"), list):
            raise ValueError("筛选总数或字段结构不合法。")
        job.update(columns=data["columns"], expected_rows=data["total"], selected_day=data.get("latest_day"), spark_time_zone=data.get("spark_time_zone"), offset=0,
                   phase="page" if data["total"] else "cleanup")
    elif job["phase"] == "page":
        rows = data.get("rows")
        expected = min(job["page_size"], job["expected_rows"] - job["offset"])
        if data.get("offset") != job["offset"] or not isinstance(rows, list) or len(rows) != expected or any(not isinstance(r, list) or len(r) != len(job["columns"]) for r in rows):
            raise ValueError("批次行数或字段不一致，未认定导出完整。")
        directory = DIRECTORY / job["id"]
        directory.mkdir(exist_ok=True)
        destination = directory / f"{job['offset']}.json"
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as file:
            json.dump(rows, file, ensure_ascii=False)
            temporary = file.name
        os.replace(temporary, destination)
        job.setdefault("pages", []).append({"offset": job["offset"], "rows": len(rows)})
        job["offset"] += len(rows)
        job["row_count"] = job["offset"]
        if job["offset"] == job["expected_rows"]:
            job["phase"] = "cleanup"
    else:
        if data.get("cleaned") is not True:
            raise ValueError("Spark 导出缓存清理未确认。")
        finalize_csv(job)
    job.pop("statement_id", None)
    job["state"] = "submitted" if job["state"] != "completed" else "completed"
    job.pop("error", None)


def finalize_csv(job):
    written = 0
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8-sig", newline="", dir=DIRECTORY, delete=False) as file:
        writer = csv.writer(file)
        writer.writerow([csv_value(name) for name in job["columns"]])
        for page in job.get("pages", []):
            if page["offset"] != written:
                raise ValueError("批次顺序不连续，未生成完整 CSV。")
            rows = json.loads((DIRECTORY / job["id"] / f"{page['offset']}.json").read_text())
            writer.writerows([csv_value(v) for v in row] for row in rows)
            written += len(rows)
        temporary = file.name
    if written != job["expected_rows"]:
        Path(temporary).unlink(missing_ok=True)
        raise ValueError("CSV 行数与筛选结果总数不一致。")
    os.replace(temporary, DIRECTORY / (job["id"] + ".csv"))
    job.update(state="completed", row_count=written, completeness_verified=True, exported_at=dt.datetime.now(dt.timezone.utc).isoformat())


def response(job):
    result = dict(job)
    result["query_id"] = result.pop("id")
    result.pop("pages", None)
    retries = result.pop("retry_events", [])
    result["recent_retry_events"] = retries[-10:]
    result["retry_count"] = job.get("retry_count", 0)
    # Keep large exports' RPC history in the local audit file, not in model context.
    traces = result.pop("trace_ids", [])
    statements = result.pop("statement_ids", [])
    result["recent_trace_ids"] = traces[-3:]
    result["recent_statement_ids"] = statements[-20:]
    result["statement_count"] = len(statements)
    result["bounded_export"] = "limit" in job  # Historical limited exports stay accurately labelled.
    if "limit" in job:
        result["note"] = "历史限量样例。"
    elif job.get("request", {}).get("action") == "sql":
        result["note"] = "按只读 SQL 结果全量导出，无总行数上限；完成时核对 CSV 行数与 SQL 结果总数。"
    else:
        result["note"] = "按筛选条件全量导出，无总行数上限；完成时核对 CSV 行数与筛选总数。"
    if job["state"] == "completed":
        result["download_url"] = f"/api/di-exports/{job['id']}.csv"
        result["local_file"] = str(DIRECTORY / (job["id"] + ".csv"))
        # Read original page values, not Excel-escaped CSV values. Bound context size.
        preview = []
        budget = 10000
        cell_truncated = False
        preview_full = False
        for page in job.get("pages", []):
            rows = json.loads((DIRECTORY / job["id"] / f"{page['offset']}.json").read_text())
            for row in rows:
                cells = [value[:500] if isinstance(value, str) else value for value in row]
                cell_truncated |= cells != row
                size = len(json.dumps(cells, ensure_ascii=False))
                if len(preview) == 20 or size > budget:
                    preview_full = True
                    break
                preview.append(cells)
                budget -= size
            if preview_full or len(preview) == 20 or budget < 1000:
                break
        request = job.get("request", {})
        kind = "sql" if request.get("action") == "sql" else "aggregate" if request.get("metrics") else "detail"
        result.update(preview_rows=preview, preview_truncated=len(preview) < job["row_count"],
                      preview_cells_truncated=cell_truncated, result_kind=kind)
    else:
        result["next_action"] = "使用 status 和同一 query_id 继续查询；不重复提交 SQL。"
    return result


def run(args):
    args = REQUEST.validate_python(args).model_dump(exclude_none=True)
    if args["action"] == "sql":
        from di_query import run_sql
        return run_sql(args)
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    with (DIRECTORY / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("已有 DI 请求正在处理，稍后查询同一 query_id。")
        if args["action"] == "status":
            query_id = args["query_id"]  # StatusRequest 已保证必填且为标准 UUID。
            job = json.loads((DIRECTORY / (query_id + ".json")).read_text())
            if args.get("topic_id") and job.get("request", {}).get("topic_id") != args["topic_id"]:
                raise ValueError("查询编号不属于当前商品成长主题。")
            if job["state"] in ("completed", "failed") or job["state"] == "unknown" and "statement_id" not in job:
                return response(job)
            if job["state"] == "unknown":
                job["state"] = "submitted"  # Known handle: polling is safe; do not resubmit.
            if "limit" in job:
                raise ValueError("旧版未完成查询需要先核对原 SQL 结果；不按新全量逻辑重新提交。")
            job.pop("error", None)  # 继续已知句柄时清除上次错误；重试记录仍保留。
        else:
            sql, latest_sql = build_sql(args)
            session = os.environ.get("DI_SESSION_ID", "")
            if session and not re.fullmatch(r"\d+", session):
                raise ValueError("DI_SESSION_ID 必须是数字；留空则在工具审批后自动创建。")
            for path in DIRECTORY.glob("*.json"):
                pending = json.loads(path.read_text())
                if pending["state"] in ("unknown", "submitted"):
                    raise ValueError(f"先用 status 核对已有查询 {pending['id']}，避免重复提交。")
            job = dict(id=str(uuid.uuid4()), table=args.get("table", "raw_sql"), request=args, sql=sql, latest_sql=latest_sql, session_id=session,
                       state="created", phase="prepare", page_size=PAGE_SIZE, row_count=0,
                       created_at=dt.datetime.now(dt.timezone.utc).isoformat(), notices=[])
        save(job)
        prefix = ["livy", "interactives", "statements"]
        try:
            if job["state"] == "created" or job.get("phase") == "session":
                if not ensure_session(job):
                    return response(job)
                job["phase"] = "prepare"
                job["state"] = "submitted"
                save(job)
            deadline = time.monotonic() + 20
            while True:
                if "statement_id" not in job:
                    job["state"] = "unknown"
                    save(job)
                    command([*prefix, "execute", job["session_id"], "--kind", "pyspark", "--code", remote_code(job)], job)
                    if "statement_id" not in job:
                        raise ValueError("提交结果未知，未取得 statement ID。请核对 session，勿重复提交。")
                    job["state"] = "submitted"
                    save(job)
                statement = command([*prefix, "get", job["session_id"], str(job["statement_id"])], job)
                if statement.get("state") == "available":
                    if statement.get("output", {}).get("status") != "ok":
                        job["state"] = "failed"
                        raise ValueError("SQL 执行失败，核对表权限、字段及筛选条件。")
                    try:
                        received = packet(statement)
                    except ValueError:
                        if job["phase"] != "page" or job["page_size"] <= 1:
                            raise
                        # Re-read a smaller slice of the same cached result, never rerun the source SQL.
                        job["page_size"] = max(1, job["page_size"] // 2)
                        job.pop("statement_id", None)
                        save(job)
                        if time.monotonic() >= deadline:
                            break
                        continue
                    accept_packet(job, received)
                    save(job)
                    if job["state"] == "completed" or time.monotonic() >= deadline:
                        break
                    continue
                if statement.get("state") not in ("waiting", "running"):
                    job["state"] = "failed"
                    raise ValueError("SQL 异常终止，未生成 CSV。")
                if time.monotonic() >= deadline:
                    break
                time.sleep(1.5)
        except (ValueError, OSError, subprocess.TimeoutExpired, KeyError) as error:
            if job["state"] == "created":
                job["state"] = "failed"
            job["error"] = str(error) if isinstance(error, ValueError) else "本机命令超时、不可用或返回结构异常；提交编号已保存，请核对原查询。"
        save(job)
        return response(job)


def main():
    # 只加载 DI 配置；已有环境变量优先，不打印其他 .env 内容。
    for key, value in dotenv_values(ROOT / ".env").items():
        if key in {"DI_SESSION_ID", "DI_SQL_SESSION_ID", "DI_IDENTITY", "DI_BIN", "DI_QUEUE", "DI_SESSION_NAME"} and value is not None:
            os.environ.setdefault(key, value)
    agent_call = os.environ.get("DI_AGENT_CALL") == "1"
    try:
        # 编辑器直接运行：改 JSON 文件即可；管道和 Agent：读取 stdin。
        if agent_call or not sys.stdin.isatty():
            content = sys.stdin.read()
        else:
            content = ""
        request = json.loads(content) if content.strip() else json.loads(
            (ROOT / "docs/di-export-request.json").read_text(encoding="utf-8"))
        from agent_backend.di_tool import create_di_export_tool, create_di_query_sql_tool
        selected_tool = create_di_query_sql_tool(executor=run) if request.get("action") == "sql" else create_di_export_tool(executor=run)
        result = json.loads(selected_tool.invoke(request))
        while not agent_call and result["state"] == "submitted" and not result.get("error"):
            print(json.dumps({"progress": result.get("row_count"), "total": result.get("expected_rows"), "query_id": result["query_id"]}), file=sys.stderr)
            result = json.loads(selected_tool.invoke({"action": "status", "query_id": result["query_id"]}))
        print(json.dumps(result, ensure_ascii=False))
    except ValidationError as error:
        # 不回显输入值；明确指出错误字段及原因。
        issues = [{"field": ".".join(map(str, item["loc"])), "message": item["msg"]}
                  for item in error.errors(include_input=False, include_url=False)]
        print(json.dumps({"state": "error", "error": "DI 请求参数不合法。", "details": issues}, ensure_ascii=False))
    except (ValueError, OSError, KeyError) as error:
        print(json.dumps({"state": "error", "error": str(error) if isinstance(error, ValueError) else "读取本地查询记录失败。"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
