"""Data API 元数据只读工具。命令白名单不包含 create/edit/release。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Literal

from langchain_core.tools import ToolException, tool

SAFE_FIELDS = {"apiId", "apiName", "apiAbbr", "projectCode", "apiEnv", "version", "status",
               "isLatest", "hasDraft", "copy", "apiMode", "datasource", "idcRegion",
               "columnName", "columnNameAlias", "columnDataType", "requestColumns", "responseColumns",
               "page", "size", "total", "totalCount", "totalPages", "items", "list", "records",
               "instances", "content", "versions", "env", "owner", "owners", "ctime", "utime"}


def _identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", value) or value.startswith("-"):
        raise ToolException("Data API 名称或版本格式不合法。")
    return value


def _safe_metadata(value):
    if isinstance(value, dict):
        return {k: _safe_metadata(v) for k, v in value.items() if k in SAFE_FIELDS}
    if isinstance(value, list):
        return [_safe_metadata(v) for v in value]
    return value


def _read(arguments: list[str]) -> dict:
    if arguments[:2] != ["dataservice", "api"] or arguments[2] not in {"list", "versions", "detail"}:
        raise ToolException("只允许 Data API list / versions / detail。")
    binary = os.environ.get("DI_BIN") or str(Path.home() / ".local/bin/di")
    try:
        result = subprocess.run([binary, *arguments, "--format", "json", "--timeout", "30s"],
                                capture_output=True, text=True, timeout=40, check=False)
    except subprocess.TimeoutExpired:
        raise ToolException("读取 Data API 超时；未执行任何 SQL。") from None
    except OSError:
        raise ToolException("无法启动 DI CLI；检查 DI_BIN。") from None
    envelope = None
    for content in (result.stdout, result.stderr):
        try:
            candidate = json.loads(content)
            if isinstance(candidate, dict) and "ok" in candidate:
                envelope = candidate
                break
        except ValueError:
            continue
    if envelope is None:
        raise ToolException("DI 未返回有效 JSON；没有读取到 Data API 定义。")
    if result.returncode or envelope.get("ok") is not True:
        kind = (envelope.get("error") or {}).get("type", "unknown")
        if kind not in {"auth", "authentication", "authorization", "permission", "network", "validation", "not_found"}:
            kind = "service_error"
        raise ToolException(f"Data API 读取失败（{kind}）；检查权限、VPN 和参数。")
    expected = os.environ.get("DI_IDENTITY", "yara.huang").removesuffix("@shopee.com")
    if envelope.get("identity") not in {expected, expected + "@shopee.com"}:
        raise ToolException("DI 身份不匹配，未返回定义。")
    data = envelope.get("data", {})
    return {"result": data.get("result", data), "trace_id": envelope.get("meta", {}).get("trace_id")}


@tool(parse_docstring=True)
def dataservice_list_apis(keyword: str, page: int = 1, size: int = 20) -> dict:
    """分页搜索当前 DI 身份可见的 Data API；不会读取表数据。

    Args:
        keyword: API 名称关键词，必须非空。
        page: 页码，从 1 开始。
        size: 本页条数，1–100。
    """
    if not keyword.strip() or len(keyword) > 200 or not 1 <= page <= 10000 or not 1 <= size <= 100:
        raise ToolException("关键词、页码或每页条数不合法。")
    result = _read(["dataservice", "api", "list", "--keyword", keyword, "--page", str(page), "--size", str(size)])
    return {"metadata": _safe_metadata(result["result"]), "page": page, "size": size,
            "trace_id": result["trace_id"], "note": "只代表当前页；不能据此宣称搜索全部完成。"}


@tool(parse_docstring=True)
def dataservice_api_versions(api_name: str) -> dict:
    """查看指定 Data API namespace 的可见版本和环境，不自动挑选最新版。

    Args:
        api_name: 完整 Data API 名称，如 cnfashionbi_scs.get_current_budget。
    """
    result = _read(["dataservice", "api", "versions", _identifier(api_name)])
    return {"api_name": api_name, "metadata": _safe_metadata(result["result"]), "trace_id": result["trace_id"]}


@tool(parse_docstring=True)
def dataservice_api_detail(api_name: str, version: str, api_copy: Literal["LIVE", "DRAFT"] = "LIVE") -> dict:
    """读取指定版本和副本的 SQL 与字段配置；不会执行、编辑或发布 SQL。

    Args:
        api_name: 完整 Data API 名称，优先从实际脚本中提取。
        version: 脚本实际使用的版本，不得用最新版代替。
        api_copy: LIVE 非草稿副本；DRAFT 草稿副本。LIVE 不代表该版本正在生产 serving，另看 status。
    """
    result = _read(["dataservice", "api", "detail", _identifier(api_name), "--version", _identifier(version), "--copy", api_copy])
    body = result["result"]
    if not isinstance(body, dict) or not isinstance(body.get("code"), str):
        raise ToolException("Data API 详情缺少 code，不能推测 SQL。")
    if body.get("apiAbbr", api_name) != api_name or body.get("version", version) != version or body.get("copy", api_copy) != api_copy:
        raise ToolException("Data API 返回的名称、版本或副本不匹配，未使用该 SQL。")
    code = body["code"]
    return {"api_name": api_name, "version": version, "copy": api_copy,
            "metadata": _safe_metadata(body), "sql": code[:20000], "sql_truncated": len(code) > 20000,
            "sql_sha256": hashlib.sha256(code.encode()).hexdigest(), "trace_id": result["trace_id"],
            "note": "这是该版本副本的当前定义，未执行 SQL；不保证与失败当天相同。LIVE 不等于生产 serving，以 status 为准。"}


DATASERVICE_TOOLS = [dataservice_list_apis, dataservice_api_versions, dataservice_api_detail]
for _tool in DATASERVICE_TOOLS:
    _tool.handle_tool_error = True
