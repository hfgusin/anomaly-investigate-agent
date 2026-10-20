"""从服务器路径映射到允许目录，只读取源码，不导入或执行脚本。"""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Annotated
from pydantic import Field
import re

from langchain_core.tools import ToolException, tool

from ..paths import ROOT

CONFIG = ROOT / "config/source-roots.json"


def _resolve_source(server_path: str) -> Path:
    if ".." in Path(server_path).parts or any(p.startswith(".") for p in Path(server_path).parts if p not in {"/", ""}):
        raise ToolException("源码路径不能包含隐藏目录或上级路径。")
    mappings = json.loads(CONFIG.read_text())["mappings"]
    for mapping in sorted(mappings, key=lambda m: len(m["server_root"]), reverse=True):
        prefix = mapping["server_root"].rstrip("/") + "/"
        if not server_path.startswith(prefix):
            continue
        root = Path(mapping["local_root"]).resolve()
        path = root / server_path[len(prefix):]
        # 不跟随映射目录内的符号链接。
        cursor = root
        for part in path.relative_to(root).parts:
            cursor /= part
            if cursor.is_symlink():
                raise ToolException("不允许通过符号链接读取源码。")
        if not path.resolve().is_relative_to(root) or path.suffix not in {".py", ".sql"}:
            raise ToolException("只能读取配置目录内的 .py / .sql 源码。")
        return path
    raise ToolException("服务器路径没有配置本地映射；不能假定对应目录。")


def _inspect(text: str, python: bool):
    references, secrets = [], []
    if python:
        try:
            tree = ast.parse(text)
        except SyntaxError:
            tree = None
        for node in ast.walk(tree) if tree else []:
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and "PRIVATE KEY-----" in node.value:
                segment = ast.get_source_segment(text, node)
                if segment:
                    secrets.append(segment)
            if not isinstance(node, ast.Call):
                continue
            name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
            if name == "generate_data":
                for arg in node.args[:2]:
                    segment = ast.get_source_segment(text, arg)
                    if segment:
                        secrets.append(segment)
                if len(node.args) >= 4 and all(isinstance(n, ast.Constant) and isinstance(n.value, str) for n in node.args[2:4]):
                    references.append({"api_name": node.args[2].value, "version": node.args[3].value, "line": node.lineno})
    sanitized = text
    for value in secrets:
        sanitized = sanitized.replace(value, repr("[凭据已隐藏]") + "\n" * value.count("\n"))
    sanitized = re.sub(r"(?im)^(.*\b(?:password|passwd|api_key|access_token|secret|cookie)\b\s*=).*$", r"\1 '[凭据已隐藏]'", sanitized)
    sanitized = re.sub(r"(?i)Bearer\s+[A-Za-z0-9._-]+", "Bearer [凭据已隐藏]", sanitized)
    if "PRIVATE KEY-----" in sanitized:
        raise ToolException("源码包含私钥，拒绝返回。")
    return sanitized, references


@tool(parse_docstring=True)
def read_project_source(server_path: str, start_line: int = 1, end_line: int = 120,
                        expected_line: int | None = None, expected_text: str | None = None,
                        keyword: Annotated[str | None, Field(min_length=1)] = None,
                        context_lines: Annotated[int, Field(ge=0, le=30)] = 8) -> dict:
    """按服务器路径读取映射的本地源码及 Data API 引用；本地文件不一定与服务器运行时版本一致。

    Args:
        server_path: 日志中的完整服务器源码路径，必须命中 config/source-roots.json。
        start_line: 起始行，从 1 开始。
        end_line: 结束行，包含该行；一次最多 160 行。
        expected_line: traceback 里该文件的行号；与 expected_text 一起传，用来核对本地是否和运行时同版本。
        expected_text: traceback 里该行的代码原文。
        keyword: 在脱敏源码中定位字面关键词，例如 log_df 或 def read_gsheet。
        context_lines: 每个关键词匹配处前后读取的行数，总计最多 160 行。
    """
    if start_line < 1 or end_line < start_line or end_line - start_line >= 160:
        raise ToolException("行号范围不合法，一次最多 160 行。")
    try:
        path = _resolve_source(server_path)
        if path.stat().st_size > 256000:
            raise ToolException("源码超过 256 KB，请先缩小文件范围。")
        text = path.read_text()
        sanitized, references = _inspect(text, path.suffix == ".py")
    except (OSError, ValueError):
        raise ToolException("读取源码或路径映射失败，检查文件是否存在。") from None
    lines = sanitized.splitlines()
    match = None
    if expected_line and expected_text:
        raw, wanted = text.splitlines(), expected_text.strip()
        found = [i + 1 for i, line in enumerate(raw) if line.strip() == wanted]
        local = lines[expected_line - 1].strip() if expected_line <= len(lines) else None
        match = {"expected_line": expected_line, "local_text": local, "same_line": expected_line in found,
                 "found_at_lines": found[:10]}
    matched = [i + 1 for i, line in enumerate(lines) if keyword and keyword in line]
    indices = list(range(start_line - 1, min(end_line, len(lines))))
    omitted = False
    if keyword:
        indices = sorted({j for i in matched for j in range(max(0, i - 1 - context_lines), min(len(lines), i + context_lines))})
        omitted = len(indices) > 160
        indices = indices[:160]
    selected = "\n".join(f"{i + 1}: {lines[i]}" for i in indices)
    return {"server_path": server_path, "local_path": str(path), "start_line": indices[0] + 1 if indices else start_line,
            "end_line": indices[-1] + 1 if indices else 0, "total_lines": len(lines), "code": selected[:14000],
            "truncated": omitted or len(selected) > 14000,
            **({"matched_lines": matched, "returned_lines": [i + 1 for i in indices]} if keyword else {}),
            "local_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "data_api_references": references, "line_match": match}


read_project_source.handle_tool_error = True
