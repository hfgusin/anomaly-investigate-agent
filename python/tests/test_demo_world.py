import json
import unittest

from langchain_core.tools import ToolException

from agent_backend import demo_world, router
from agent_backend.paths import ROOT
from agent_backend.tools import tools_by_name

WORLDS = ROOT / "portfolio/evaluation/worlds"
RANGE = {"start_date": "2026-10-10", "end_date": "2026-10-15", "server": "automation"}


class DemoWorldTests(unittest.TestCase):
    def setUp(self):
        self.tools = tools_by_name()

    def test_worlds_drive_real_tools(self):
        with demo_world.installed(demo_world.load(WORLDS / "W01.json")):
            scan = self.tools["airflow_scan_failures"].func(**RANGE)
            task = scan["failed_tasks"][0]
            log = self.tools["airflow_get_task_log"].func(task["dag_id"], task["dag_run_id"], task["task_id"], 1,
                                                          server="automation", keyword="KeyError", context_lines=0)
            source = self.tools["read_project_source"].func("/home/toc/SSE/yara/ads/dday_get_current_budget.py", 178, 178,
                                                            expected_line=178, expected_text="df = df[df['region'] == region]")
            sql = json.loads(self.tools["di_query_sql"].func(
                action="sql", sql="select max(grass_date) from cnfashionbi_scs.ads_budget_snapshot"))
        self.assertEqual(scan["owned_dags"], ["dday_get_current_budget"])
        self.assertIn("KeyError: 'region'", log["snippets"][0]["log"])
        self.assertFalse(source["line_match"]["same_line"])
        self.assertEqual(sql["preview_rows"], [["2026-10-12"]])

    def test_owner_filter_and_auth_failure(self):
        with demo_world.installed(demo_world.load(WORLDS / "W05.json")):
            self.assertEqual(self.tools["airflow_scan_failures"].func(**RANGE)["failed_tasks"], [])
        with demo_world.installed(demo_world.load(WORLDS / "W04.json")), self.assertRaisesRegex(ToolException, "401"):
            self.tools["airflow_scan_failures"].func(**RANGE)


class RouterPromptTests(unittest.TestCase):
    def test_prompt_uses_skill_titles_and_examples(self):
        prompt = router.system_prompt([{"text": "scs_take_rate_ads 昨天正常吗", "route": "ads-check"}])
        self.assertIn("每日自动化失败排查", prompt)
        self.assertIn("广告自动化排查", prompt)
        self.assertIn("输入：scs_take_rate_ads 昨天正常吗 → ads-check", prompt)


if __name__ == "__main__":
    unittest.main()
