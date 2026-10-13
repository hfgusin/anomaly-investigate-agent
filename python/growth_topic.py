"""主题配置只维护表路由和日期边界；字段以真实 Spark schema 为准。"""
import json
from pathlib import Path

CATALOG = json.loads((Path(__file__).resolve().parents[1] / "data/topics/growth.json").read_text())


def validate_query(request):
    table = next((t for t in CATALOG["tables"] if t["name"] == request["table"]), None)
    if table is None:
        raise ValueError("此表不在商品成长主题范围内。")
    if request.get("date_column") != table["dateColumn"] or not (request.get("latest_day") or request.get("start")):
        raise ValueError("商品成长查询必须使用该表日期字段并提供时间范围或 latest_day。")
    if not request.get("metrics") and not request.get("columns"):
        raise ValueError("主题明细必须显式选择 columns，不允许 SELECT *。")
