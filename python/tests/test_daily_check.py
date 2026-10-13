"""日常排查工具的合成场景；不连接公司服务，不执行真实 SQL。"""
import asyncio
from collections import deque
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from urllib.parse import unquote
import unittest
from unittest.mock import patch

import httpx
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import ToolException, tool
from agent_backend import runtime
from agent_backend.tools import airflow, airflow_scan, dataservice, project_source, check_records
from agent_backend.catalog import catalog
from debug_agent import DebugGateway


class ScanTests(unittest.TestCase):
    def test_connection_info_is_local_and_never_returns_credentials(self):
        with patch.dict("os.environ", {"AIRFLOW_BASE_URL": "https://user:password@fixture:8080/path?token=secret",
                                       "AIRFLOW_TOKEN": "secret"}, clear=True), patch.object(airflow, "_client") as client:
            result = airflow.airflow_connection_info.invoke({})
        client.assert_not_called()
        self.assertEqual(result["connections"][0]["base_url"], "https://fixture:8080/path")
        self.assertFalse(result["connections"][0]["connectivity_verified"])
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("password", json.dumps(result))

    def run_scan(self, respond, **args):
        client = airflow.AirflowClient("https://fixture.example", transport=httpx.MockTransport(respond))
        with patch.object(airflow_scan, "_client", return_value=client):
            return airflow_scan.airflow_scan_failures.invoke({"start_date": "2026-10-08", "end_date": "2026-10-13", **args})

    def fixture(self, request):
        path, params = request.url.raw_path.decode(), request.url.params
        if path.startswith("/api/v1/dags?"):
            return httpx.Response(200, json={"dags": [{"dag_id": "a", "owners": ["yara"]}, {"dag_id": "other", "owners": ["yara2"]}],
                                             "total_entries": 2})
        self.assertIn("/dagRuns/~/taskInstances", path)
        self.assertEqual(params["state"], "failed")
        self.assertEqual(params["start_date_gte"], "2026-10-07T16:00:00+00:00")
        self.assertEqual(params["start_date_lte"], "2026-10-13T15:59:59.999999+00:00")
        page = [{"dag_id": "a", "dag_run_id": "manual__x", "task_id": "broken", "state": "failed", "try_number": 1,
                 "execution_date": "2026-09-01T00:00:00Z"},
                {"dag_id": "other", "dag_run_id": "r", "task_id": "t", "state": "failed", "try_number": 1}]
        if params["offset"] == "0":
            return httpx.Response(200, json={"task_instances": page, "total_entries": 3})
        return httpx.Response(200, json={"task_instances": [{**page[0], "task_id": "second"}], "total_entries": 3})

    def test_owner_filter_pagination_and_manual_run(self):
        result = self.run_scan(self.fixture)
        self.assertEqual(result["owned_dags"], ["a"])
        self.assertEqual([t["task_id"] for t in result["failed_tasks"]], ["broken", "second"])
        self.assertEqual(result["failed_tasks"][0]["execution_date"], "2026-09-01T00:00:00Z")
        self.assertIn("dag_run_id=manual__x", result["failed_tasks"][0]["url"])

    def test_single_dag_checks_owner_and_scopes_request(self):
        paths = []
        def respond(request):
            paths.append(request.url.raw_path.decode())
            if request.url.path == "/api/v1/dags/a":
                return httpx.Response(200, json={"dag_id": "a", "owners": ["yara"]})
            return httpx.Response(200, json={"task_instances": [], "total_entries": 0})
        self.assertEqual(self.run_scan(respond, dag_id="a")["failed_tasks"], [])
        self.assertTrue(paths[1].startswith("/api/v1/dags/a/dagRuns/~/taskInstances"))

    def test_no_owned_dags_skips_task_query(self):
        def respond(request):
            self.assertTrue(request.url.path.endswith("/dags"), "must not query tasks")
            return httpx.Response(200, json={"dags": [{"dag_id": "b", "owners": ["someone"]}], "total_entries": 1})
        self.assertEqual(self.run_scan(respond)["owned_dags"], [])

    def test_invalid_dates_do_not_request(self):
        for args in ({"start_date": "invalid"}, {"end_date": "2026-10-01"}, {"time_zone": "CST"}):
            self.assertIsInstance(self.run_scan(lambda _: self.fail("must not request"), **args), str)

    def test_api_error_is_reported_not_swallowed(self):
        self.assertIn("HTTP 500", self.run_scan(lambda _: httpx.Response(500)))


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = self.root / "roots.json"
        self.config.write_text(json.dumps({"mappings": [{"server_root": "/srv/code", "local_root": str(self.root)}]}))
        self.patch = patch.object(project_source, "CONFIG", self.config)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_reads_without_execution_and_extracts_api_redacts_credentials(self):
        (self.root / "a.py").write_text("raise RuntimeError('must not execute')\nresult = generate_data('service-secret', 'credential-secret', 'project.api', 'version1', {})\n")
        result = project_source.read_project_source.invoke({"server_path": "/srv/code/a.py"})
        self.assertEqual(result["data_api_references"], [{"api_name": "project.api", "version": "version1", "line": 2}])
        self.assertNotIn("credential-secret", result["code"])
        self.assertNotIn("service-secret", result["code"])
        self.assertIsNone(result["line_match"])

    def test_line_match_detects_version_drift(self):
        (self.root / "a.py").write_text("a = 1\ndf = df[df['shop_id'] == shop_id]\ndf = df[df['region'] == region]\n")
        args = {"server_path": "/srv/code/a.py", "expected_line": 2, "expected_text": "  df = df[df['region'] == region]"}
        match = project_source.read_project_source.invoke(args)["line_match"]
        self.assertFalse(match["same_line"])
        self.assertEqual(match["local_text"], "df = df[df['shop_id'] == shop_id]")
        self.assertEqual(match["found_at_lines"], [3])
        self.assertTrue(project_source.read_project_source.invoke({**args, "expected_line": 3})["line_match"]["same_line"])

    def test_denies_traversal_hidden_files_and_symlinks(self):
        (self.root / "linked.py").symlink_to("/etc/passwd")
        for path in ("/srv/code/../a.py", "/srv/code/.env", "/srv/code/linked.py", "/another/a.py"):
            result = project_source.read_project_source.invoke({"server_path": path})
            self.assertIsInstance(result, str)

    def test_line_numbers_and_truncation(self):
        (self.root / "a.sql").write_text("SELECT 1;\n" * 170)
        result = project_source.read_project_source.invoke({"server_path": "/srv/code/a.sql", "start_line": 10, "end_line": 12})
        self.assertEqual(result["code"].splitlines()[0], "10: SELECT 1;")
        self.assertEqual(len(result["code"].splitlines()), 3)


class DataServiceTests(unittest.TestCase):
    def success(self, body):
        return subprocess.CompletedProcess([], 0, json.dumps({"ok": True, "identity": "yara.huang@shopee.com", "data": {"result": body}, "meta": {"trace_id": "trace1"}}), "")

    def test_detail_preserves_actual_sql_and_hides_unrelated_credentials(self):
        sql = "-- old D-1\nSELECT 1"
        with patch.object(dataservice.subprocess, "run", return_value=self.success({"code": sql, "version": "v1", "accessToken": "secret"})) as run:
            result = dataservice.dataservice_api_detail.invoke({"api_name": "project.api", "version": "v1"})
        self.assertEqual(result["sql"], sql)
        self.assertNotIn("secret", json.dumps(result))
        self.assertIn("detail", run.call_args.args[0])
        self.assertIn("LIVE", run.call_args.args[0])
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_version_list_and_search_are_read_commands(self):
        with patch.object(dataservice.subprocess, "run", return_value=self.success({"items": [{"version": "v1", "apiEnv": "PROD"}], "total": 1})) as run:
            self.assertEqual(dataservice.dataservice_api_versions.invoke({"api_name": "project.api"})["metadata"]["items"][0]["version"], "v1")
            result = dataservice.dataservice_list_apis.invoke({"keyword": "budget", "page": 2})
            self.assertEqual(result["page"], 2)
            self.assertEqual(run.call_args.args[0][1:4], ["dataservice", "api", "list"])

    def test_invalid_identifier_never_starts_cli(self):
        with patch.object(dataservice.subprocess, "run") as run:
            result = dataservice.dataservice_api_detail.invoke({"api_name": "--release", "version": "v1"})
        run.assert_not_called()
        self.assertIn("不合法", result)

    def test_cli_failure_and_missing_sql_do_not_become_empty_sql(self):
        failure = subprocess.CompletedProcess([], 4, "", json.dumps({"ok": False, "error": {"type": "network", "message": "secret"}}))
        with patch.object(dataservice.subprocess, "run", return_value=failure):
            result = dataservice.dataservice_api_detail.invoke({"api_name": "p.a", "version": "v1"})
            self.assertIn("network", result)
            self.assertNotIn("secret", result)
        with patch.object(dataservice.subprocess, "run", return_value=self.success({"version": "v1"})):
            self.assertIn("缺少 code", dataservice.dataservice_api_detail.invoke({"api_name": "p.a", "version": "v1"}))


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(check_records, "DATABASE", Path(self.tmp.name) / "records.sqlite"),
                        patch.object(check_records, "gsheet_token", return_value="fixture")]
        for item in self.patches:
            item.start()
        self.args = dict(server="automation", dag_id="a", dag_run_id="r", task_id="t", try_number=1,
                         error_summary="KeyError", facts="缺少列", hypotheses="可能为空", evidence=["fixture://log"],
                         suggestions="核对数据", coverage="单个任务")

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.tmp.cleanup()

    def record(self, **changes):
        return check_records.record_automation_check.invoke({**self.args, **changes})

    def test_repeat_updates_one_row_and_preserves_first_check_time(self):
        with patch.object(check_records, "_sync", return_value={"row": 2}):
            first = self.record()
            second = self.record(facts="已验证")
        self.assertEqual(first["record_id"], second["record_id"])
        self.assertTrue(second["updated"])
        with check_records._db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM records").fetchone()[0], 1)
            payload = json.loads(db.execute("SELECT payload FROM records").fetchone()[0])
        self.assertEqual(payload["facts"], "已验证")
        self.assertNotEqual(payload["checked_at"], payload["updated_at"])

    def test_different_attempt_has_different_identity(self):
        with patch.object(check_records, "_sync", return_value={"row": 2}):
            self.assertNotEqual(self.record()["record_id"], self.record(try_number=2)["record_id"])

    def test_sync_failure_keeps_local_record_and_retry_succeeds(self):
        with patch.object(check_records, "gsheet_token", side_effect=ToolException("未配置 GSheet")):
            failed = self.record()
        self.assertTrue(failed["record_saved"])
        self.assertEqual(failed["sync_status"], "pending")
        self.assertIn("未配置 GSheet", failed["sync_error"])
        with patch.object(check_records, "_sync", return_value={"row": 2}):
            self.assertEqual(self.record()["sync_status"], "synced")
        with check_records._db() as db:
            self.assertEqual(db.execute("SELECT sync_status FROM records").fetchone()[0], "synced")

    def sheet_fixture(self, rows, bad_header=False, fail_append=False):
        calls = []
        def respond(request):
            path = unquote(request.url.path)
            calls.append(request.method)
            if request.method == "GET":
                if "A1:P1" in path:
                    return httpx.Response(200, json={"values": [["existing header"]] if bad_header else [check_records.HEADERS]})
                return httpx.Response(200, json={"values": [[rows[i][0]] if i in rows else [] for i in range(2, max(rows, default=1) + 1)]})
            self.assertEqual(request.url.params["valueInputOption"], "RAW")
            values = json.loads(request.content)["values"][0]
            if request.method == "POST":
                rows[max(rows, default=1) + 1] = values
                if fail_append:
                    raise httpx.ReadTimeout("server already appended", request=request)
            else:
                rows[int(path.split("!A")[1].split(":")[0])] = values
            return httpx.Response(200, json={})
        return respond, calls

    def record_with_sheet(self, respond):
        actual_client = httpx.Client
        def client(**kwargs):
            return actual_client(**kwargs, transport=httpx.MockTransport(respond))
        with patch.object(check_records.httpx, "Client", side_effect=client):
            return self.record()

    def test_append_then_repeat_updates_same_row(self):
        rows = {}
        respond, calls = self.sheet_fixture(rows)
        first = self.record_with_sheet(respond)
        second = self.record_with_sheet(respond)
        self.assertEqual((first["sync_status"], second["sync_status"]), ("synced", "synced"))
        self.assertEqual(second["row"], 2)
        self.assertEqual(len(rows), 1)
        self.assertEqual((calls.count("POST"), calls.count("PUT")), (1, 1))

    def test_append_timeout_then_retry_updates_instead_of_duplicating(self):
        rows = {}
        respond, _ = self.sheet_fixture(rows, fail_append=True)
        self.assertEqual(self.record_with_sheet(respond)["sync_status"], "pending")
        respond, calls = self.sheet_fixture(rows)
        self.assertEqual(self.record_with_sheet(respond)["sync_status"], "synced")
        self.assertEqual(len(rows), 1)
        self.assertNotIn("POST", calls)

    def test_bad_header_does_not_write_sheet(self):
        respond, calls = self.sheet_fixture({}, bad_header=True)
        result = self.record_with_sheet(respond)
        self.assertEqual(result["sync_status"], "pending")
        self.assertIn("表头", result["sync_error"])
        self.assertEqual(set(calls), {"GET"})


class LogTests(unittest.TestCase):
    def test_segment_cursor_and_local_export(self):
        client = airflow.AirflowClient("https://fixture", transport=httpx.MockTransport(lambda _: httpx.Response(200, text="abcdefghij")))
        with patch.object(airflow, "_client", return_value=client):
            result = airflow.airflow_get_task_log.invoke({"dag_id": "a", "dag_run_id": "r", "task_id": "t", "try_number": 1,
                                                         "offset": 0, "max_chars": 4})
        self.assertEqual(result["log"], "abcd")
        self.assertEqual(result["next_offset"], 4)
        self.assertTrue(result["truncated"])
        self.assertIn("/logs/1", result["source"])

    def test_export_saves_complete_received_log_with_private_permissions(self):
        client = airflow.AirflowClient("https://fixture", transport=httpx.MockTransport(lambda _: httpx.Response(200, text="log evidence")))
        with tempfile.TemporaryDirectory() as directory, patch.object(airflow, "_client", return_value=client), \
             patch.object(airflow, "DATA_DIR", Path(directory)):
            result = airflow.airflow_get_task_log.invoke({"dag_id": "a", "dag_run_id": "r", "task_id": "t", "try_number": 1, "export_log": True})
            path = Path(result["local_path"])
            self.assertEqual(path.read_text(), "log evidence")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class ToolModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


class FlowTests(unittest.TestCase):
    def test_top_level_failed_business_state_is_not_tool_error(self):
        @tool
        def query_business_state() -> dict:
            """读取业务任务状态。"""
            return {"state": "failed"}
        from agent_backend import tools
        model = ToolModel(responses=[
            AIMessage(content="", tool_calls=[{"id": "one", "name": "query_business_state", "args": {}}], response_metadata={"finish_reason": "tool_calls"}),
            AIMessage(content="业务任务失败，查询成功", response_metadata={"finish_reason": "stop"})])
        request = runtime.StartRequest(type="start", messages=[{"role": "user", "content": "查询"}], toolDefinitions=[{"function": {"name": "query_business_state"}}])
        gateway = DebugGateway(approve=lambda *_: True)
        with patch.object(tools, "TOOLS", [query_business_state]), patch.dict("os.environ", {"MIRROR_RUNTIME": "chat-completions"}):
            messages = asyncio.run(runtime.run(request, model=model, send=gateway.send, recv=gateway.receive))
        self.assertEqual(messages[-2].status, "success")
        self.assertFalse(gateway.last_tool_result["isError"])

    def test_airflow_approval_runs_actual_toolnode_and_denial_has_no_requests(self):
        for approved in (True, False):
            requests = []
            def respond(request):
                requests.append(request)
                return httpx.Response(200, json={"task_id": "t", "state": "failed", "try_number": 1})
            client = airflow.AirflowClient("https://fixture", transport=httpx.MockTransport(respond))
            model = ToolModel(responses=[
                AIMessage(content="先查当前任务状态，确定日志尝试编号。", tool_calls=[{"id": "one", "name": "airflow_get_task", "args": {"dag_id": "a", "dag_run_id": "r", "task_id": "t"}}], response_metadata={"finish_reason": "tool_calls"}),
                AIMessage(content="已完成检查", response_metadata={"finish_reason": "stop"})])
            request = runtime.StartRequest(type="start", messages=[{"role": "user", "content": "查失败原因"}], toolDefinitions=[{"function": {"name": "airflow_get_task"}}])
            gateway = DebugGateway(approve=lambda *_: approved)
            stdout = io.StringIO()
            with patch.object(airflow, "_client", return_value=client), patch.dict("os.environ", {"MIRROR_RUNTIME": "chat-completions"}), redirect_stdout(stdout):
                messages = asyncio.run(runtime.run(request, model=model, send=gateway.send, recv=gateway.receive))
            self.assertEqual(len(requests), int(approved))
            if approved:
                self.assertEqual(messages[-2].status, "success")  # 查询到业务 failed，不是工具 failed。
                self.assertEqual(json.loads(messages[-2].content)["task"]["state"], "failed")
            else:
                self.assertTrue(messages[-2].additional_kwargs["mirror"]["denied"])
            self.assertTrue(any(e["type"] == "provider_event" and e["event"] == "agent.action" for e in gateway.events))
            self.assertNotIn("topic_id", gateway.last_tool_arguments)

    def test_emit_stdout_is_only_json(self):
        out = io.StringIO()
        with redirect_stdout(out):
            runtime.emit("text", text="中文\n分行")
        frames = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(frames, [{"type": "text", "text": "中文\n分行"}])

    def test_catalog_uses_python_schema_and_write_risks(self):
        entries = {entry["definition"]["function"]["name"]: entry for entry in catalog()}
        for name in ("airflow_scan_failures", "dataservice_api_detail", "read_project_source", "record_automation_check"):
            self.assertIn("daily-check", entries[name]["skills"])
        self.assertEqual(entries["record_automation_check"]["risk"], "write")
        self.assertFalse(entries["record_automation_check"]["autoApprove"])
        self.assertTrue(entries["airflow_get_task_log"]["autoApprove"])
        self.assertEqual(entries["greet_user"]["skills"], [])


if __name__ == "__main__":
    unittest.main()
