import unittest
from urllib.parse import parse_qs
from unittest.mock import patch

import httpx

from agent_backend.tools import airflow


class AirflowTests(unittest.TestCase):
    def invoke(self, tool, arguments, respond):
        client = airflow.AirflowClient("https://airflow.example", username="reader", password="pw",
                                       transport=httpx.MockTransport(respond))
        with patch.object(airflow, "_client", return_value=client):
            return tool.invoke(arguments)

    def test_list_dags_paginates_and_keeps_selected_fields(self):
        def respond(request):
            self.assertEqual(request.url.path, "/api/v1/dags")
            self.assertEqual(request.url.params["offset"], "10")
            self.assertTrue(request.headers["Authorization"].startswith("Basic "))
            return httpx.Response(200, json={"dags": [{"dag_id": "daily", "is_paused": False, "extra": 1}],
                                             "total_entries": 30})
        result = self.invoke(airflow.airflow_list_dags, {"offset": 10}, respond)
        self.assertEqual(result["next_offset"], 11)
        self.assertEqual(result["items"], [{"dag_id": "daily", "is_paused": False}])

    def test_run_id_is_encoded_and_mapped_task_uses_path(self):
        def respond(request):
            self.assertEqual(request.url.raw_path.decode(),
                             "/api/v1/dags/d/dagRuns/scheduled__2026-10-01T07%3A00%3A00%2B00%3A00/taskInstances/t/3")
            return httpx.Response(200, json={"task_id": "t", "state": "failed", "try_number": 2})
        result = self.invoke(airflow.airflow_get_task, {
            "dag_id": "d", "dag_run_id": "scheduled__2026-10-01T07:00:00+00:00", "task_id": "t", "map_index": 3}, respond)
        self.assertEqual(result["task"]["try_number"], 2)

    def test_log_returns_tail(self):
        def respond(request):
            self.assertTrue(request.url.path.endswith("/taskInstances/t/logs/2"))
            return httpx.Response(200, text="x" * 13000 + "END")
        result = self.invoke(airflow.airflow_get_task_log,
                                        {"dag_id": "d", "dag_run_id": "r", "task_id": "t", "try_number": 2}, respond)
        self.assertTrue(result["truncated"])
        self.assertTrue(result["log"].endswith("END"))
        self.assertEqual(len(result["log"]), airflow.LOG_TAIL_CHARS)

    def test_http_errors_become_readable_tool_errors(self):
        for status, expected in [(401, "认证失败"), (404, "找不到"), (500, "HTTP 500")]:
            result = self.invoke(airflow.airflow_get_dag, {"dag_id": "d"}, lambda _, s=status: httpx.Response(s))
            self.assertIn(expected, result)

    def test_automation_server_reads_its_own_env(self):
        env = {"AIRFLOW_BASE_URL": "https://main.example", "AIRFLOW_USERNAME": "reader",
               "AUTOMATION_AIRFLOW_BASE_URL": "https://ads.example", "AUTOMATION_AIRFLOW_COOKIE": "session=ads"}
        with patch.dict("os.environ", env, clear=True):
            client = airflow._client("automation")
        self.assertEqual(client.base_url, "https://ads.example/api/v1")
        self.assertEqual(client.headers["Cookie"], "session=ads")
        self.assertIsNone(client.auth)
        with patch.dict("os.environ", {}, clear=True):
            self.assertIn("AUTOMATION_AIRFLOW_BASE_URL",
                          airflow.airflow_get_dag.invoke({"dag_id": "d", "server": "automation"}))

    def test_cookie_auth_is_not_overwritten(self):
        def respond(request):
            self.assertEqual(request.headers["Cookie"], "session=configured")
            return httpx.Response(200, json={"dag_id": "d"})
        client = airflow.AirflowClient("https://airflow.example", cookie="session=configured",
                                       transport=httpx.MockTransport(respond))
        self.assertEqual(client.get("dags", "d").json()["dag_id"], "d")

    def test_automatic_login_uses_csrf_and_session_cookie_then_retries_original_get(self):
        calls = []
        def respond(request):
            calls.append((request.method, request.url.path))
            if request.url.path == "/api/v1/dags":
                if len(calls) == 1:
                    return httpx.Response(401)
                self.assertEqual(request.headers["Cookie"], "session=authenticated")
                self.assertEqual(request.url.params["limit"], "1")
                return httpx.Response(200, json={"dags": [], "total_entries": 0})
            if request.url.path == "/login/" and request.method == "GET":
                return httpx.Response(200, text='<input value="csrf&amp;token" type="hidden" name="csrf_token">',
                                      headers={"Set-Cookie": "session=prelogin; Path=/"})
            if request.url.path == "/login/" and request.method == "POST":
                self.assertEqual(request.headers["Cookie"], "session=prelogin")
                form = parse_qs(request.content.decode())
                self.assertEqual(form["csrf_token"], ["csrf&token"])
                self.assertEqual(form["username"], ["reader"])
                self.assertEqual(form["password"], ["pw"])
                return httpx.Response(302, headers={"Location": "/home", "Set-Cookie": "session=authenticated; Path=/"})
            if request.url.path == "/home":
                self.assertEqual(request.headers["Cookie"], "session=authenticated")
                return httpx.Response(200, text="paid_ads_automation_scs")
            self.fail(f"unexpected request: {request.method} {request.url.path}")
        result = self.invoke(airflow.airflow_list_dags, {"limit": 1}, respond)
        self.assertEqual(result["items"], [])
        self.assertEqual(calls.count(("GET", "/api/v1/dags")), 2)
        self.assertEqual(calls.count(("POST", "/login/")), 1)

    def test_missing_csrf_does_not_post_credentials(self):
        calls = []
        def respond(request):
            calls.append(request.method)
            if request.url.path.startswith("/api/"):
                return httpx.Response(401)
            return httpx.Response(200, text="login page without token")
        result = self.invoke(airflow.airflow_list_dags, {}, respond)
        self.assertIn("CSRF", result)
        self.assertNotIn("POST", calls)

    def test_failed_login_does_not_retry_api_or_report_success(self):
        calls = []
        def respond(request):
            calls.append((request.method, request.url.path))
            if request.url.path.startswith("/api/"):
                return httpx.Response(401)
            if request.url.path == "/home":
                return httpx.Response(302, headers={"Location": "/login/"})
            return httpx.Response(200, text='<input name="csrf_token" value="token">')
        result = self.invoke(airflow.airflow_list_dags, {}, respond)
        self.assertIn("登录失败", result)
        self.assertEqual(calls.count(("GET", "/api/v1/dags")), 1)

    def test_bearer_auth_failure_does_not_submit_web_credentials(self):
        calls = []
        def respond(request):
            calls.append(request.method)
            return httpx.Response(401)
        client = airflow.AirflowClient("https://airflow.example", token="fixture-token", username="reader", password="pw",
                                       transport=httpx.MockTransport(respond))
        with self.assertRaisesRegex(airflow.ToolException, "认证失败"):
            client.get("dags")
        self.assertEqual(calls, ["GET"])


if __name__ == "__main__":
    unittest.main()
