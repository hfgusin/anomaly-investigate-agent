"""主题与聚合边界测试，不连接生产 DI。"""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pydantic import ValidationError

import di_export
from agent_backend.di_tool import create_di_export_tool
from di_models import REQUEST


def query():
    return dict(action="query", topic_id="growth", table="cnfashionbi_scs.scs_item_growth_performance_by_day",
                date_column="grass_date", latest_day=True, filters=[dict(column="grass_region", operator="=", value="TH")],
                group_by=["growing_period"], metrics=[dict(function="sum", column="shop_gmv", alias="gmv"),
                dict(function="ratio_sums", column="ads_gmv", denominator="ads_exp", alias="roas")])


class GrowthTests(unittest.TestCase):
    def test_aggregate_is_structured_tool_and_generates_weighted_ratio(self):
        requests = []
        tool = create_di_export_tool(lambda req: requests.append(req) or {"state": "submitted"})
        tool.invoke(query())
        sql, latest = di_export.build_sql(requests[0])
        self.assertIn("GROUP BY `growing_period` ORDER BY `growing_period`", sql)
        self.assertIn("CASE WHEN SUM(CAST(`ads_exp` AS DOUBLE)) = 0 THEN NULL", sql)
        self.assertIn("'TH'", latest)
        self.assertNotIn("LIMIT", sql)

    def test_scope_and_field_guards_before_executor(self):
        calls = []
        tool = create_di_export_tool(lambda req: calls.append(req))
        for changes in ({"table": "private.secrets"}, {"date_column": "date"}, {"latest_day": False},
                        {"columns": None, "metrics": None, "group_by": []}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                tool.invoke(query() | changes)
        self.assertEqual(calls, [])

    def test_topic_routes_tables_without_copying_the_spark_schema(self):
        request = query() | {"group_by": ["runtime_schema_field"],
                             "metrics": [{"function": "sum", "column": "runtime_metric", "alias": "value"}]}
        self.assertEqual(REQUEST.validate_python(request).table, request["table"])

    def test_status_retains_topic_scope(self):
        calls = []
        request = dict(action="status", topic_id="growth", query_id="0f449fb7-37ac-4c20-b0ec-8053a4a2f706")
        create_di_export_tool(lambda req: calls.append(req)).invoke(request)
        self.assertEqual(calls, [request])

    def test_status_cannot_read_other_topic_job(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(di_export, "DIRECTORY", Path(directory)):
            identifier = "0f449fb7-37ac-4c20-b0ec-8053a4a2f706"
            Path(directory, identifier + ".json").write_text(json.dumps(dict(id=identifier, state="completed")))
            with self.assertRaisesRegex(ValueError, "不属于"):
                di_export.run(dict(action="status", query_id=identifier, topic_id="growth"))

    def test_preview_is_bounded_and_original_values_are_retained(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(di_export, "DIRECTORY", Path(directory)):
            root = Path(directory); (root / "example").mkdir()
            rows = [["=not-a-command", n] for n in range(25)]
            (root / "example/0.json").write_text(json.dumps(rows))
            result = di_export.response(dict(id="example", state="completed", row_count=25,
                        pages=[dict(offset=0)], columns=["label", "value"], request=query()))
            self.assertEqual(len(result["preview_rows"]), 20)
            self.assertTrue(result["preview_truncated"])
            self.assertEqual(result["preview_rows"][0][0], "=not-a-command")
            self.assertEqual(result["result_kind"], "aggregate")


if __name__ == "__main__":
    unittest.main()
