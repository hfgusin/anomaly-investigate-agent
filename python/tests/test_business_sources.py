import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from langchain_core.tools import ToolException

from agent_backend.tools import business_sources


class BusinessSourcesTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "sources.md"
        self.rows = [
            {"taskId": None, "taskName": "shipping_log", "projectCode": "fixture",
             "description": "渠道全量开启", "aliases": ["渠道没开"], "relateScript": "~/shipping.py",
             "taskStatus": "SUCCESS"},
            {"taskId": 12, "taskName": "ads_phlocal", "projectCode": "fixture",
             "description": "渠道广告", "tableName": "fixture.ads_log", "regions": ["PH"],
             "dateColumn": "action_time", "timezone": "Asia/Shanghai"},
        ]
        self.write()
        patcher = patch.object(business_sources, "BUSINESS_SOURCES", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self):
        self.path.write_text(json.dumps(self.rows, ensure_ascii=False))

    def test_keywords_rank_candidates_and_keep_unknown_fields(self):
        result = business_sources.search_business_sources.invoke({"query": "渠道 开启", "limit": 1})
        self.assertEqual(result["total_matches"], 2)
        self.assertEqual(result["source_file"], "sources.md")
        self.assertEqual(len(result["matches"]), 1)
        row = result["matches"][0]
        self.assertEqual(row["record_index"], 1)
        self.assertEqual(row["script"], "~/shipping.py")
        self.assertIsNone(row["task_id"])
        self.assertIsNone(row["table_name"])
        self.assertIsNone(row["date_column"])
        self.assertNotIn("taskStatus", row)

    def test_identifiers_aliases_and_explicit_table_metadata(self):
        for query in ["PHLOCAL", "12", "fixture.ads_log"]:
            row = business_sources.search_business_sources.invoke({"query": query})["matches"][0]
            self.assertEqual(row["task_name"], "ads_phlocal")
            self.assertEqual(row["table_name"], "fixture.ads_log")
            self.assertEqual(row["regions"], ["PH"])
        result = business_sources.search_business_sources.invoke({"query": "渠道没开"})
        self.assertEqual(result["matches"][0]["task_name"], "shipping_log")

    def test_exact_name_precedes_partial_name(self):
        self.rows.insert(0, {"taskId": 13, "taskName": "old_shipping_log", "projectCode": "fixture"})
        self.write()
        result = business_sources.search_business_sources.invoke({"query": "shipping_log"})
        self.assertEqual(result["matches"][0]["task_name"], "shipping_log")

    def test_reload_on_each_query_and_no_match(self):
        self.assertEqual(business_sources.search_business_sources.invoke({"query": "新增业务"})["matches"], [])
        self.rows[0]["description"] = "新增业务"
        self.write()
        self.assertEqual(business_sources.search_business_sources.invoke({"query": "新增业务"})["total_matches"], 1)

    def test_invalid_or_missing_catalog_is_an_error_not_no_matches(self):
        for content in ["[{", '{"taskName": "not a list"}', '[{"taskId": "12"}]']:
            self.path.write_text(content)
            with self.assertRaises(ToolException):
                business_sources.search_business_sources.func("渠道")
        self.path.unlink()
        with self.assertRaises(ToolException):
            business_sources.search_business_sources.func("渠道")
        self.assertIn("校验失败", business_sources.search_business_sources.invoke({"query": "渠道"}))

    def test_blank_query_is_rejected(self):
        with self.assertRaises(ToolException):
            business_sources.search_business_sources.func("  ")


if __name__ == "__main__":
    unittest.main()
