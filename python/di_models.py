"""Agent 和本地脚本共用的 DI 请求格式；校验发生在任何 DI 调用之前。"""
import datetime as dt
import re
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, TypeAdapter, field_validator, model_validator

Identifier = Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")]
TableName = Annotated[str, Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,127}\.[A-Za-z_][A-Za-z0-9_]{0,127}$")]
TextValue = Annotated[str, Field(max_length=500, pattern=r"^[^\\\x00-\x1f]*$")]
DateText = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$")]
SQLText = Annotated[str, Field(min_length=1, max_length=7_000)]

SQL_FORBIDDEN = {
    "add", "alter", "analyze", "cache", "call", "create", "delete", "dfs", "drop", "grant",
    "insert", "into", "java_method", "load", "merge", "msck", "reflect", "refresh", "rename", "replace",
    "revoke", "set", "transform", "truncate", "uncache", "update", "use",
}


def readonly_sql(value: str) -> str:
    """Accept one SELECT/CTE statement while ignoring keywords inside quotes/comments."""
    sql = value.strip()
    if len(sql.encode("utf-8")) > 7_000:
        raise ValueError("SQL UTF-8 内容不能超过 7000 字节。")
    visible = []
    index = 0
    quote = None
    block_comment = False
    while index < len(sql):
        char = sql[index]
        following = sql[index + 1] if index + 1 < len(sql) else ""
        if block_comment:
            if char == "*" and following == "/":
                visible.extend("  "); index += 2; block_comment = False
            else:
                visible.append(" "); index += 1
            continue
        if quote:
            visible.append(" ")
            if char == quote:
                if following == quote:
                    visible.append(" "); index += 2; continue
                quote = None
            index += 1
            continue
        if char == "-" and following == "-":
            end = sql.find("\n", index + 2)
            end = len(sql) if end < 0 else end
            visible.extend(" " * (end - index)); index = end; continue
        if char == "/" and following == "*":
            visible.extend("  "); index += 2; block_comment = True; continue
        if char in ("'", '"', "`"):
            visible.append(" "); quote = char; index += 1; continue
        visible.append(char); index += 1
    if quote or block_comment:
        raise ValueError("SQL 引号或注释没有闭合。")
    check = "".join(visible).strip()
    if check.endswith(";") and sql.endswith(";") and check.count(";") == 1:
        check = check[:-1].rstrip()
        sql = sql[:-1].rstrip()
    if ";" in check:
        raise ValueError("只允许一条 SQL。")
    tokens = [token.lower() for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", check)]
    if not tokens or tokens[0] not in ("select", "with") or "select" not in tokens:
        raise ValueError("只允许 SELECT 或 WITH ... SELECT 查询。")
    forbidden = SQL_FORBIDDEN.intersection(tokens)
    if forbidden:
        raise ValueError("SQL 包含非只读关键字：" + ", ".join(sorted(forbidden)))
    return sql


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Filter(RequestModel):
    column: Identifier
    operator: Literal["=", "!=", ">", ">=", "<", "<="]
    value: Union[TextValue, StrictInt, StrictFloat]


class Metric(RequestModel):
    function: Literal["count", "count_distinct", "sum", "avg", "ratio_sums"]
    alias: Identifier
    column: Identifier | None = None
    denominator: Identifier | None = None

    @model_validator(mode="after")
    def check_arguments(self):
        if self.function != "count" and self.column is None:
            raise ValueError("指标必须指定 column。")
        if (self.function == "ratio_sums") != (self.denominator is not None):
            raise ValueError("只有 ratio_sums 必须指定 denominator。")
        return self


class QueryRequest(RequestModel):
    action: Literal["query"]
    table: TableName
    columns: Annotated[list[Identifier], Field(min_length=1, max_length=100)] | None = None
    filters: Annotated[list[Filter], Field(max_length=10)] = Field(default_factory=list)
    date_column: Identifier | None = None
    start: DateText | None = None
    end: DateText | None = None
    latest_day: bool = False
    latest_scope: Literal["filtered", "table"] = "filtered"
    topic_id: Literal["growth"] | None = None
    metrics: Annotated[list[Metric], Field(min_length=1, max_length=12)] | None = None
    group_by: Annotated[list[Identifier], Field(max_length=5)] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_dates(self):
        if self.action == "status":
            return self  # Combined LangChain input validates status via StatusRequest.
        if self.metrics and self.columns or self.group_by and not self.metrics:
            raise ValueError("聚合使用 metrics/group_by，不能同时指定明细 columns。")
        names = self.group_by + [metric.alias for metric in self.metrics or []]
        if len(set(names)) != len(names):
            raise ValueError("分组字段和指标别名不能重复。")
        has_range = self.start is not None or self.end is not None
        if self.latest_day and has_range:
            raise ValueError("latest_day 不能与 start/end 同时使用。")
        if (self.latest_day or has_range) and self.date_column is None:
            raise ValueError("查询日期时必须指定 date_column。")
        if has_range:
            if self.start is None or self.end is None:
                raise ValueError("start/end 必须一起填写。")
            if dt.datetime.fromisoformat(self.start) >= dt.datetime.fromisoformat(self.end):
                raise ValueError("end 必须晚于 start；不包含结束时间。")
        # if self.topic_id:
        #     from growth_topic import validate_query
        #     validate_query(self.model_dump(exclude_none=True))
        return self


class RawSQLRequest(RequestModel):
    action: Literal["sql"]
    sql: SQLText
    topic_id: Literal["growth"] | None = None

    @field_validator("sql")
    @classmethod
    def check_sql(cls, value):
        return readonly_sql(value)


class StatusRequest(RequestModel):
    action: Literal["status"]
    query_id: str
    topic_id: Literal["growth"] | None = None

    @field_validator("query_id")
    @classmethod
    def check_query_id(cls, value):
        if str(UUID(value)) != value:
            raise ValueError("query_id 必须是标准小写 UUID。")
        return value


# action 决定使用哪种模型；status 不能偷偷携带新查询参数。
REQUEST = TypeAdapter(Annotated[Union[QueryRequest, RawSQLRequest, StatusRequest], Field(discriminator="action")])
