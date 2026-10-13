"""本地服务账号认证；只解析字面量，不执行凭据文件里的 Python。"""
from __future__ import annotations

import ast
from functools import lru_cache, partial
import json
import os
from pathlib import Path

from langchain_core.tools import ToolException

from .paths import ROOT

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
GOOGLE_TOKEN_URIS = {"https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token"}


def load_service_account(path: Path, name: str = "client_secret") -> dict:
    try:
        text = path.read_text()
        try:
            info = json.loads(text)
        except json.JSONDecodeError:
            tree = ast.parse(text)
            matches = [node.value for node in tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
            if len(matches) != 1:
                raise ToolException("服务账号名称未找到或重复；检查 CHECK_GSHEET_SERVICE_ACCOUNT_NAME。")
            info = ast.literal_eval(matches[0])
        if not isinstance(info, dict) or info.get("type") != "service_account":
            raise ToolException("文件不是 Google 服务账号凭据。")
        if not info.get("private_key") or not info.get("client_email") or info.get("token_uri") not in GOOGLE_TOKEN_URIS:
            raise ToolException("服务账号缺少字段或 token_uri 不是受支持的 Google 地址。")
        return info
    except (OSError, SyntaxError, ValueError, TypeError):
        raise ToolException("读取服务账号文件失败；仅支持标准 JSON 或命名字典字面量。") from None


@lru_cache(maxsize=4)
def _credentials(path: str, name: str, modified_ns: int):
    from google.oauth2.service_account import Credentials
    return Credentials.from_service_account_info(load_service_account(Path(path), name), scopes=SCOPES)


def gsheet_token() -> str:
    # 显式服务账号优先；兼容之前的手动 OAuth token。
    configured = os.environ.get("CHECK_GSHEET_SERVICE_ACCOUNT_FILE")
    if configured:
        path = Path(configured)
        if not path.is_absolute():
            path = ROOT / path
        name = os.environ.get("CHECK_GSHEET_SERVICE_ACCOUNT_NAME", "client_secret")
        try:
            from google.auth.transport.requests import Request
            credentials = _credentials(str(path.resolve()), name, path.stat().st_mtime_ns)
            if not credentials.valid:
                credentials.refresh(partial(Request(), timeout=15))
            if not credentials.token:
                raise ToolException("服务账号没有取得访问令牌。")
            return credentials.token
        except ToolException:
            raise
        except ImportError:
            raise ToolException("缺少 google-auth[requests]；请安装 python/requirements.txt。") from None
        except Exception:
            # google-auth 原始异常可能包含凭据或远端正文。
            raise ToolException("Google 服务账号认证失败；检查文件、账号有效性与 Google 网络连接。") from None
    token = os.environ.get("CHECK_GSHEET_ACCESS_TOKEN") or os.environ.get("AUTOMATION_GSHEET_ACCESS_TOKEN")
    if not token:
        raise ToolException("未配置 GSheet 服务账号文件或 CHECK_GSHEET_ACCESS_TOKEN；本地记录仍保留。")
    return token
