"""2026-10-10 dday_get_current_budget 回归样例：证据链各环节都要拿到能推出正确结论的证据。

case.json 同时是真实模型评测用例：grade() 检查最终回答是否把根因归到“查询 0 行”，而不是停在 KeyError。
"""
import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import httpx
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, ToolMessage

from agent_backend import runtime
from agent_backend.tools import airflow, airflow_scan, dataservice, project_source
from debug_agent import DebugGateway

FIXTURES = Path(__file__).parent / "fixtures/dday_get_current_budget_1010"
CASE = json.loads((FIXTURES / "case.json").read_text())


def grade(answer: str, case: dict = CASE) -> list[str]:
    problems = [f"缺少：{word}" for word in case["answer_must_mention"] if word not in answer]
    problems += [f"缺少其一：{group}" for group in case["answer_must_mention_any"] if not any(w in answer for w in group)]
    problems += [f"不应出现：{word}" for word in case["answer_must_not_mention"] if word in answer]
    return problems


class ScriptedModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def call(name, **args):
    return AIMessage(content="", tool_calls=[{"id": name, "name": name, "args": args}], response_metadata={"finish_reason": "tool_calls"})


class DdayBudgetRegression(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        lines = [f"# line {i}" for i in range(1, 200)]
        lines[114] = "result = generate_data('service', 'credential', 'cnfashionbi_scs.get_current_budget', 'ozgurgr5zt4icuun', {})"
        lines[177] = "df = df[df['shop_id'] == shop_id]"
        lines[179] = "df = df[df['region'] == region]"
        (root / "ads").mkdir()
        (root / "ads/dday_get_current_budget.py").write_text("\n".join(lines) + "\n")
        config = root / "roots.json"
        config.write_text(json.dumps({"mappings": [{"server_root": "/home/toc/SSE/yara", "local_root": str(root)}]}))
        task = CASE["task"]
        log = (FIXTURES / "task.log").read_text()

        def respond(request):
            path = request.url.raw_path.decode()
            if path.startswith("/api/v1/dags?"):
                return httpx.Response(200, json={"dags": [{"dag_id": task["dag_id"], "owners": ["yara"]}], "total_entries": 1})
            if "/logs/" in path:
                return httpx.Response(200, text=log)
            return httpx.Response(200, json={"task_instances": [{**task, "state": "failed"}], "total_entries": 1})

        client = airflow.AirflowClient("https://fixture", transport=httpx.MockTransport(respond))
        detail = {"ok": True, "identity": "yara.huang@shopee.com", "meta": {"trace_id": "trace"},
                  "data": {"result": {"code": (FIXTURES / "api_detail.sql").read_text(), "status": "PRE_RELEASE", **CASE["data_api"]}}}
        self.patches = [patch.object(airflow, "_client", return_value=client),
                        patch.object(airflow_scan, "_client", return_value=client),
                        patch.object(project_source, "CONFIG", config),
                        patch.object(dataservice.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(detail), "")),
                        patch.dict("os.environ", {"MIRROR_RUNTIME": "chat-completions"})]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.tmp.cleanup()

    def test_evidence_chain_supports_empty_result_conclusion(self):
        task, trace, api = CASE["task"], CASE["traceback"], CASE["data_api"]
        answer = ("sql datas: 0：Data API 在 grass_date = date_add('day', -1, current_date) 上返回 0 行，"
                  "空 DataFrame 没有 region 列，KeyError 只是表现。")
        model = ScriptedModel(responses=[
            call("airflow_scan_failures", start_date="2026-10-05", end_date="2026-10-10"),
            call("airflow_get_task_log", dag_id=task["dag_id"], dag_run_id=task["dag_run_id"], task_id=task["task_id"],
                 try_number=1, server="automation", offset=0),
            call("read_project_source", server_path=trace["server_path"], start_line=170, end_line=185,
                 expected_line=trace["line"], expected_text=trace["text"]),
            call("dataservice_api_detail", **api),
            AIMessage(content=answer, response_metadata={"finish_reason": "stop"})])
        names = ["airflow_scan_failures", "airflow_get_task_log", "read_project_source", "dataservice_api_detail"]
        request = runtime.StartRequest(type="start", messages=[{"role": "user", "content": "/daily-check"}],
                                       toolDefinitions=[{"function": {"name": n}} for n in names])
        gateway = DebugGateway(approve=lambda *_: True)
        with redirect_stdout(io.StringIO()):
            messages = asyncio.run(runtime.run(request, model=model, send=gateway.send, recv=gateway.receive))
        results = {m.name: json.loads(m.content) for m in messages if isinstance(m, ToolMessage)}
        self.assertEqual(set(results), set(names))

        scan = results["airflow_scan_failures"]["failed_tasks"]
        self.assertEqual([(t["dag_run_id"], t["try_number"]) for t in scan], [(task["dag_run_id"], 1)])
        log = results["airflow_get_task_log"]["log"]
        self.assertLess(log.index("sql datas: 0"), log.index("KeyError: 'region'"))
        self.assertIn("indexes/range.py", log)  # RangeIndex：DataFrame 没有任何列，即空结果。
        source = results["read_project_source"]
        self.assertFalse(source["line_match"]["same_line"])
        self.assertEqual(source["line_match"]["found_at_lines"], [180])
        self.assertEqual(source["data_api_references"][0], {**api, "line": 115})
        sql = results["dataservice_api_detail"]["sql"]
        self.assertIn("date_add('day', -1, current_date)", sql.splitlines()[-1])
        self.assertEqual(grade(messages[-1].text), [])

    def test_grade_rejects_answer_that_stops_at_keyerror(self):
        self.assertTrue(grade("KeyError: 'region'，建议检查 region 列。"))


if __name__ == "__main__":
    unittest.main()
