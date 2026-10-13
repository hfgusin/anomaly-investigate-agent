"""本地故障注入；不连接 DI、不创建 Spark session。"""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pydantic import ValidationError
from langchain_core.tools import StructuredTool
from langchain_core.utils.function_calling import convert_to_openai_tool

import di_export
import di_query
from agent_backend.di_tool import create_di_export_tool, create_di_query_sql_tool
from agent_backend.di_retry import DIRetryMiddleware, TransientDIError


class DIToolTests(unittest.TestCase):
    def test_direct_sql_bypasses_pending_exports_and_preserves_sql(self):
        calls = []
        sql = "SELECT item_id FROM db.sales -- keep comment\nWHERE day = current_date"
        def invoke(arguments, **kwargs):
            calls.append(arguments)
            envelope = {"ok": True, "identity": "yara.huang@shopee.com", "data": {
                "session": {"sessionId": 42}, "statements": [{"statementId": 0, "state": "available",
                "output": {"status": "ok", "data": {"application/json": {
                    "schema": [{"name": "item_id", "type": "long"}], "data": [[n] for n in range(30)]}}}}]},
                "meta": {"trace_id": "fixture"}}
            kwargs["stdout"].write(json.dumps(envelope).encode())
            return SimpleNamespace(returncode=0)
        with patch.object(di_query.subprocess, "run", side_effect=invoke), \
             patch.object(di_export, "ensure_session", side_effect=AssertionError("must not export")), \
             patch.dict("os.environ", {"DI_SESSION_ID": "expired", "DI_SQL_SESSION_ID": "", "DI_IDENTITY": "yara.huang"}):
            result = json.loads(create_di_query_sql_tool().invoke({"action": "sql", "sql": sql}))
            self.assertEqual(__import__("os").environ["DI_SQL_SESSION_ID"], "42")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["columns"], ["item_id"])
        self.assertEqual(len(result["preview_rows"]), 20)
        self.assertEqual(result["returned_rows"], 30)
        self.assertFalse(result["completeness_verified"])
        self.assertNotIn("download_url", result)
        self.assertEqual(calls[0][1:3], ["livy", "+sql"])
        self.assertEqual(calls[0][calls[0].index("--sql") + 1], sql)
        self.assertNotIn("--session-id", calls[0])

    def test_direct_sql_timeout_is_unknown_and_not_retried(self):
        import subprocess
        with patch.object(di_query.subprocess, "run", side_effect=subprocess.TimeoutExpired("di", 330)) as invoke:
            result = di_query.run_sql({"action": "sql", "sql": "SELECT 1"})
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(invoke.call_count, 1)

    def test_direct_sql_error_envelope_after_progress(self):
        def invoke(_arguments, **kwargs):
            kwargs["stderr"].write(b'[di] checking quota\n' + json.dumps({"ok": False,
                "identity": "yara.huang", "error": {"type": "cost_gate", "detail": {"code": "quota"}}}).encode())
            return SimpleNamespace(returncode=1)
        with patch.object(di_query.subprocess, "run", side_effect=invoke):
            result = di_query.run_sql({"action": "sql", "sql": "SELECT 1"})
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["recovery"], {"code": "quota"})

    def test_expired_sql_session_falls_back_to_new_session_once(self):
        calls = []
        def invoke(arguments, **kwargs):
            calls.append(arguments)
            if "--session-id" in arguments:
                kwargs["stderr"].write(json.dumps({"ok": False, "identity": "yara.huang", "error": {
                    "type": "api", "detail": {"status": 404, "operation_id": "getInteractiveSession"}}}).encode())
                return SimpleNamespace(returncode=1)
            kwargs["stdout"].write(json.dumps({"ok": True, "identity": "yara.huang", "data": {
                "session": {"sessionId": 7}, "statements": [{"statementId": 0, "state": "available",
                "output": {"status": "ok", "data": {"application/json": {
                    "schema": [{"name": "n"}], "data": [[1]]}}}}]}}).encode())
            return SimpleNamespace(returncode=0)
        with patch.object(di_query.subprocess, "run", side_effect=invoke), \
             patch.dict("os.environ", {"DI_SQL_SESSION_ID": "123", "DI_IDENTITY": "yara.huang"}):
            result = di_query.run_sql({"action": "sql", "sql": "SELECT 1"})
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["session_id"], 7)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("--session-id", calls[1])

    def test_debug_gateway_only_approves_and_does_not_execute(self):
        import asyncio
        from debug_agent import DebugGateway
        gateway = DebugGateway()
        with patch("debug_agent.APPROVE_DI_QUERY", True), \
             patch("agent_backend.di_tool.execute_di_sql_request", side_effect=AssertionError("must not execute here")):
            gateway.send("python_tool_call", id="test", name="di_query_sql",
                         arguments=json.dumps({"action": "sql", "sql": "SELECT 1"}))
            result = asyncio.run(gateway.receive())
        self.assertEqual(result["id"], "test")
        self.assertEqual(result["type"], "tool_approval")
        self.assertTrue(result["approved"])
        self.assertNotIn("topic_id", result["arguments"])

    def test_real_structured_tool_and_status(self):
        inputs = []
        tool = create_di_export_tool(lambda request: inputs.append(request) or {"state": "completed"})
        self.assertIsInstance(tool, StructuredTool)
        request = {"action": "status", "query_id": "0f449fb7-37ac-4c20-b0ec-8053a4a2f706"}
        self.assertEqual(json.loads(tool.invoke(request))["state"], "completed")
        self.assertEqual(inputs, [request])
        self.assertEqual(convert_to_openai_tool(tool)["function"]["name"], "di_export_table")

    def test_query_filters_are_normalized(self):
        inputs = []
        tool = create_di_export_tool(lambda request: inputs.append(request) or {"state": "submitted"})
        tool.invoke({"action": "query", "table": "db.table", "latest_day": True, "date_column": "date",
                     "filters": [{"column": "site", "operator": "=", "value": "BRFA"}]})
        sql, _ = di_export.build_sql(inputs[0])
        self.assertIn("'BRFA'", sql)
        self.assertNotIn("LIMIT", sql)
        self.assertNotIn("query_id", inputs[0])

    def test_raw_sql_tool_accepts_one_read_only_query(self):
        inputs = []
        tool = create_di_query_sql_tool(lambda request: inputs.append(request) or {"state": "submitted"})
        sql = """WITH ranked AS (
            SELECT shop_id, SUM(gmv) AS gmv, ROW_NUMBER() OVER (ORDER BY SUM(gmv) DESC) AS rank
            FROM db.sales WHERE note = 'drop table is text' GROUP BY shop_id
        ) SELECT * FROM ranked WHERE rank <= 10;"""
        self.assertEqual(json.loads(tool.invoke({"action": "sql", "sql": sql}))["state"], "submitted")
        self.assertEqual(inputs[0]["action"], "sql")
        self.assertTrue(inputs[0]["sql"].endswith("rank <= 10"))
        self.assertEqual(di_export.build_sql(inputs[0]), (inputs[0]["sql"], None))
        self.assertEqual(convert_to_openai_tool(tool)["function"]["name"], "di_query_sql")

    def test_raw_sql_tool_rejects_writes_and_multiple_statements(self):
        calls = []
        tool = create_di_query_sql_tool(lambda request: calls.append(request))
        invalid = [
            "DELETE FROM db.sales",
            "SELECT * FROM db.sales; DROP TABLE db.sales",
            "WITH source AS (SELECT * FROM db.sales) INSERT INTO db.out SELECT * FROM source",
            "SHOW TABLES",
            "SELECT * FROM db.sales; -- trailing comment",
            "SELECT TRANSFORM(value) USING 'cat' FROM db.sales",
            "SELECT reflect('java.lang.Runtime', 'getRuntime')",
            "SELECT 'unterminated",
        ]
        for sql in invalid:
            with self.subTest(sql=sql), self.assertRaises(ValidationError):
                tool.invoke({"action": "sql", "sql": sql})
        self.assertEqual(calls, [])

    def test_bad_input_does_not_execute(self):
        inputs = []
        tool = create_di_export_tool(lambda request: inputs.append(request))
        for request in ({"action": "query", "table": "db.table", "limit": 10},
                        {"action": "query"},
                        {"action": "status", "query_id": "bad"},
                        {"action": "status", "query_id": "0f449fb7-37ac-4c20-b0ec-8053a4a2f706", "latest_day": False}):
            with self.assertRaises(ValidationError):
                tool.invoke(request)
        self.assertEqual(inputs, [])

    def test_safe_read_retries_twice_and_records_reason(self):
        calls = []; waits = []; job = {}
        def read():
            calls.append(1)
            if len(calls) < 3:
                raise TransientDIError("network")
            return "ok"
        middleware = DIRetryMiddleware(sleep=waits.append, clock=lambda: 0)
        self.assertEqual(middleware.invoke(read, ["livy", "interactives", "statements", "get", "1", "9"], job, lambda _: None), "ok")
        self.assertEqual(len(calls), 3)
        self.assertEqual(waits, [1, 2])
        self.assertEqual(job["retry_count"], 2)
        self.assertTrue(all(e["reason"] == "network" for e in job["retry_events"]))

    def test_retry_exhaustion(self):
        calls = []; job = {}
        def read():
            calls.append(1)
            raise TransientDIError("timeout")
        with self.assertRaises(TransientDIError):
            DIRetryMiddleware(sleep=lambda _: None, clock=lambda: 0).invoke(read,
                ["livy", "interactives", "get", "1"], job, lambda _: None)
        self.assertEqual(len(calls), 3)
        self.assertFalse(job["retry_events"][-1]["will_retry"])

    def test_permanent_errors_never_retry(self):
        for kind in ("auth", "permission", "validation", "interrupted", "cost_gate"):
            calls = []
            def read():
                calls.append(1)
                raise ValueError(kind)
            with self.assertRaises(ValueError):
                DIRetryMiddleware().invoke(read, ["livy", "interactives", "get", "1"], {}, lambda _: None)
            self.assertEqual(len(calls), 1)

    def test_submit_and_unknown_commands_never_retry(self):
        for arguments in (["livy", "interactives", "statements", "execute", "1"],
                          ["livy", "interactives", "stop", "1"], ["unexpected", "get"]):
            calls = []
            def operation():
                calls.append(1)
                raise TransientDIError("network")
            with self.assertRaises(TransientDIError):
                DIRetryMiddleware().invoke(operation, arguments, {}, lambda _: None)
            self.assertEqual(len(calls), 1)

    def test_server_backoff_is_respected(self):
        waits = []; calls = []
        def read():
            calls.append(1)
            if len(calls) == 1:
                raise TransientDIError("network", retry_after_ms=5000)
            return "ok"
        DIRetryMiddleware(sleep=waits.append, clock=lambda: 0).invoke(read,
            ["livy", "interactives", "get", "1"], {}, lambda _: None)
        self.assertEqual(waits, [5])

    def test_backoff_beyond_budget_stops(self):
        job = {}
        def read():
            raise TransientDIError("network", retry_after_ms=60000)
        with self.assertRaises(TransientDIError):
            DIRetryMiddleware(sleep=lambda _: self.fail("must not sleep"), clock=lambda: 0).invoke(
                read, ["livy", "interactives", "get", "1"], job, lambda _: None)
        self.assertFalse(job["retry_events"][0]["will_retry"])

    def test_real_command_network_envelope_is_retried(self):
        calls = []
        def subprocess_run(arguments, **kwargs):
            calls.append(arguments)
            failed = len(calls) < 3
            envelope = {"ok": not failed, "identity": "yara.huang", "data": {"result": {"owner": "yara.huang"}},
                        "error": {"type": "network"}, "meta": {"trace_id": "fixture"}}
            kwargs["stderr" if failed else "stdout"].write(json.dumps(envelope).encode())
            return SimpleNamespace(returncode=4 if failed else 0)
        with tempfile.TemporaryDirectory() as directory, patch.object(di_export, "DIRECTORY", Path(directory)), \
             patch.object(di_export.subprocess, "run", subprocess_run):
            middleware = DIRetryMiddleware(sleep=lambda _: None, clock=lambda: 0)
            job = {"id": "fixture", "notices": []}
            with patch.object(di_export, "DIRetryMiddleware", return_value=middleware):
                self.assertEqual(di_export.command(["livy", "interactives", "get", "1"], job)["owner"], "yara.huang")
            self.assertEqual(len(calls), 3)
            self.assertEqual(job["retry_count"], 2)
            self.assertNotIn("di_error", job)

    def test_expired_session_is_replaced_after_query_approval(self):
        calls = []
        def invoke(arguments, _job):
            calls.append(arguments)
            if arguments[:3] == ["livy", "interactives", "get"]:
                raise di_export.DICommandError("api", 404)
            return {"id": 2, "owner": "yara.huang", "state": "starting"}
        job = {"id": "fixture", "session_id": "1", "state": "created", "phase": "prepare", "notices": []}
        with patch.object(di_export, "command", side_effect=invoke), patch.object(di_export, "save"):
            self.assertFalse(di_export.ensure_session(job))
        self.assertEqual(job["session_id"], "2")
        self.assertEqual(job["phase"], "session")
        self.assertEqual(job["state"], "submitted")
        self.assertIn("session 1 已过期", job["notices"][0])
        self.assertEqual(calls[1][:3], ["livy", "interactives", "create"])

    def test_status_continues_when_created_session_becomes_idle(self):
        job = {"id": "fixture", "session_id": "2", "state": "submitted", "phase": "session", "notices": []}
        with patch.object(di_export, "command", return_value={"id": 2, "owner": "yara.huang", "state": "idle"}), \
             patch.object(di_export, "save"):
            self.assertTrue(di_export.ensure_session(job))

    def test_unknown_submission_stays_unknown_and_status_does_not_resubmit(self):
        calls = []
        def subprocess_run(arguments, **kwargs):
            execute = arguments[4] == "execute"
            calls.append("execute" if execute else "get")
            envelope = {"ok": not execute, "identity": "yara.huang",
                        "data": {"result": {} if execute else {"owner": "yara.huang"}},
                        "error": {"type": "network"}, "meta": {"trace_id": "fixture"}}
            kwargs["stderr" if execute else "stdout"].write(json.dumps(envelope).encode())
            return SimpleNamespace(returncode=4 if execute else 0)
        with tempfile.TemporaryDirectory() as directory, patch.object(di_export, "DIRECTORY", Path(directory)), \
             patch.dict("os.environ", {"DI_SESSION_ID": "1", "DI_IDENTITY": "yara.huang"}), \
             patch.object(di_export.subprocess, "run", subprocess_run):
            result = di_export.run({"action": "query", "table": "db.table"})
            self.assertEqual(result["state"], "unknown")
            self.assertEqual(calls.count("execute"), 1)
            resumed = di_export.run({"action": "status", "query_id": result["query_id"]})
            self.assertEqual(resumed["state"], "unknown")
            self.assertEqual(calls.count("execute"), 1)


if __name__ == "__main__":
    unittest.main()
