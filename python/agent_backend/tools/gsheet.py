"""读取业务日志表的当前表头和有限样例。"""
from datetime import datetime, timezone
from typing import Annotated
from urllib.parse import quote

import httpx
from langchain_core.tools import ToolException, tool
from pydantic import Field

from ..gsheet_auth import gsheet_token


@tool(parse_docstring=True)
def read_gsheet_rows(spreadsheet_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]+$")],
                     tab_name: Annotated[str, Field(min_length=1, max_length=100)],
                     start_row: Annotated[int, Field(ge=1)] = 1,
                     row_count: Annotated[int, Field(ge=1, le=20)] = 5,
                     columns: Annotated[str, Field(pattern=r"^[A-Z]{1,2}:[A-Z]{1,2}$")] = "A:G") -> dict:
    """只读获取 GSheet 指定 tab 的原始行，保留表头空格，核对缺列和表头位置。

    Args:
        spreadsheet_id: 源码中的表格 ID。
        tab_name: 源码和运行站点映射得到的实际 tab 名称。
        start_row: 起始行号，从 1 开始。
        row_count: 读取行数，最多 20 行；包含表头时也占一行。
        columns: 列范围，例如 A:G。
    """
    first, last = columns.split(":")
    sheet = "'" + tab_name.replace("'", "''") + "'"
    range_ = f"{sheet}!{first}{start_row}:{last}{start_row + row_count - 1}"
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{quote(range_, safe='')}"
    try:
        response = httpx.get(url, headers={"Authorization": f"Bearer {gsheet_token()}"},
                             params={"valueRenderOption": "FORMATTED_VALUE"}, timeout=15)
        if response.is_error:
            raise ToolException(f"GSheet HTTP {response.status_code}；请检查权限、表格 ID、tab 和范围，不能据此判断为空数据。")
        rows = response.json().get("values", [])
    except (httpx.HTTPError, ValueError):
        raise ToolException("GSheet 请求或响应解析失败，尚未取得表头和数据。") from None
    return {"spreadsheet_id": spreadsheet_id, "tab_name": tab_name, "range": range_,
            "read_at": datetime.now(timezone.utc).isoformat(), "rows": rows,
            "empty": not rows}


read_gsheet_rows.handle_tool_error = True
