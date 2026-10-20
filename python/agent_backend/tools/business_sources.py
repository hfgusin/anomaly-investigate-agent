"""按业务说明检索人工维护的来源目录。"""
import json
from typing import Annotated

from langchain_core.tools import ToolException, tool
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from ..paths import BUSINESS_SOURCES


class BusinessSource(BaseModel):
    model_config = ConfigDict(strict=True)

    task_id: int | None = Field(alias="taskId")
    task_name: str = Field(alias="taskName", min_length=1)
    project_code: str = Field(alias="projectCode", min_length=1)
    description: str | None = None
    script: str | None = Field(default=None, alias="relateScript")
    aliases: list[str] = Field(default_factory=list)
    table_name: str | None = Field(default=None, alias="tableName")
    regions: list[str] = Field(default_factory=list)
    date_column: str | None = Field(default=None, alias="dateColumn")
    timezone: str | None = None


@tool(parse_docstring=True)
def search_business_sources(
    query: Annotated[str, Field(min_length=1, max_length=200)],
    limit: Annotated[int, Field(ge=1, le=20)] = 5,
) -> dict:
    """按任务名、ID、业务描述、别名、表名或脚本检索本地来源目录，返回候选记录与出处。

    Args:
        query: 简短关键词；多个词用空格隔开，匹配任一词，按命中词数排序，例如「渠道 开启」或「phlocal」。
        limit: 最多返回多少条候选，1–20。
    """
    terms = set(query.casefold().split())
    if not terms:
        raise ToolException("请提供业务关键词、任务名或 ID。")
    try:
        sources = TypeAdapter(list[BusinessSource]).validate_python(json.loads(BUSINESS_SOURCES.read_text()))
    except (OSError, ValueError):
        raise ToolException("来源目录读取或校验失败；请检查 script_and_data_info_record.md 的 JSON 和字段类型。") from None
    matches = []
    for index, source in enumerate(sources, 1):
        fields = [source.task_name, str(source.task_id) if source.task_id is not None else "",
                  source.description or "", source.script or "", source.table_name or "", *source.aliases]
        score = sum(any(term in field.casefold() for field in fields) for term in terms)
        if not score:
            continue
        exact = query.strip().casefold() in [field.casefold() for field in fields if field]
        matches.append((exact, score, {"record_index": index, **source.model_dump()}))
    matches.sort(key=lambda match: (match[0], match[1]), reverse=True)
    return {"source_file": BUSINESS_SOURCES.name, "total_matches": len(matches),
            "matches": [match[2] for match in matches[:limit]]}


search_business_sources.handle_tool_error = True
