"""Airflow 只读查询工具（REST API v1）。

每种查询一个工具，函数签名就是模型看到的参数 schema。连接配置只来自环境变量：

    AIRFLOW_BASE_URL                     服务根地址，如 http://host:8080
    AIRFLOW_TOKEN                        填了就用 Bearer 认证
    AIRFLOW_USERNAME / AIRFLOW_PASSWORD  先用 Basic；API 拒绝认证时自动登录网页获取会话
    AIRFLOW_COOKIE                       可选，原样作为 Cookie 头（有的部署 API 只认网页会话）

每个工具的 server 参数选择服务器：default 读上面的 AIRFLOW_*；automation 是广告自动化
（scs_take_rate_ads 等）所在的服务器，读同名的 AUTOMATION_AIRFLOW_* 变量。

命令行调用见 agent_backend/airflow_cli.py（自动化看板也走那里）。
"""
from __future__ import annotations

import hashlib
import os
from html.parser import HTMLParser
from typing import Annotated, Literal
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from langchain_core.tools import ToolException, tool
from pydantic import Field

from ..paths import DATA_DIR

LOG_TAIL_CHARS = 12_000
DAG_FIELDS = ("dag_id", "owners", "fileloc", "is_paused", "is_active", "description", "tags", "schedule_interval", "max_active_runs")
RUN_FIELDS = ("dag_id", "dag_run_id", "state", "logical_date", "execution_date", "start_date", "end_date")
TASK_FIELDS = ("dag_id", "dag_run_id", "task_id", "state", "try_number", "map_index",
               "start_date", "end_date", "duration")
ENV_PREFIXES = {"default": "AIRFLOW_", "automation": "AUTOMATION_AIRFLOW_"}
Server = Literal["default", "automation"]


class _CSRFParser(HTMLParser):
    """读取登录表单隐藏字段，不依赖 HTML 属性顺序。"""

    def __init__(self):
        super().__init__()
        self.token = None
        self.has_password = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "input" and attrs.get("type") == "password":
            self.has_password = True
        if tag == "input" and attrs.get("name") == "csrf_token":
            self.token = attrs.get("value")


class AirflowClient:
    """只读 API 客户端；仅认证时 POST 登录表单。"""

    def __init__(self, base_url: str, *, token: str = "", username: str = "", password: str = "",
                 cookie: str = "", transport: httpx.BaseTransport | None = None):
        if not base_url:
            raise ToolException("未配置 AIRFLOW_BASE_URL。")
        self.root_url = base_url.rstrip("/")
        self.base_url = self.root_url + "/api/v1"
        self.username, self.password = username, password
        self.token = token
        self.headers = {"Cookie": cookie} if cookie else {}
        self.auth = None
        if token:
            self.headers["Authorization"] = f"Bearer {token}"
        elif username:
            self.auth = httpx.BasicAuth(username, password)
        self.transport = transport

    @classmethod
    def from_env(cls, prefix: str = "AIRFLOW_") -> AirflowClient:
        def env(name: str) -> str:
            return os.environ.get(prefix + name, "")
        if not env("BASE_URL"):
            raise ToolException(f"未配置 {prefix}BASE_URL。")
        return cls(env("BASE_URL"), token=env("TOKEN"), username=env("USERNAME"),
                   password=env("PASSWORD"), cookie=env("COOKIE"))

    def login_airflow(self, http: httpx.Client) -> None:
        """获取 CSRF 并登录；同一个 Client 自动保存、携带会话 Cookie。"""
        if not self.username or not self.password:
            raise ToolException("自动登录需要 AIRFLOW_USERNAME 和 AIRFLOW_PASSWORD。")
        home_url = self.root_url + "/home"
        # 固定 Cookie header 会覆盖 Cookie jar，先移除旧值，使用服务器的新会话。
        http.headers.pop("Cookie", None)
        login_page = http.get(self.root_url + "/login/", params={"next": home_url},
                              headers={"Accept": "text/html"}, follow_redirects=True)
        login_page.raise_for_status()
        parser = _CSRFParser()
        parser.feed(login_page.text)
        if login_page.url.path.rstrip("/") == "/home" and not parser.has_password:
            return  # 服务端已识别当前会话。
        if not parser.token:
            raise ToolException("Airflow 登录页未返回 CSRF 令牌。")
        response = http.post(self.root_url + "/login/", data={
            "csrf_token": parser.token, "username": self.username,
            "password": self.password, "next": home_url,
        }, headers={"Referer": str(login_page.url), "Accept": "text/html"}, follow_redirects=True)
        response.raise_for_status()
        home = http.get(home_url, headers={"Accept": "text/html"}, follow_redirects=True)
        home.raise_for_status()
        parser = _CSRFParser()
        parser.feed(home.text)
        if home.url.path.rstrip("/") != "/home" or parser.has_password:
            raise ToolException("Airflow 登录失败：检查账号密码。")

    def get(self, *segments: str | int, params: dict | None = None,
            accept: str = "application/json") -> httpx.Response:
        # Run IDs contain ":" and "+", so every path segment is percent-encoded.
        path = "/" + "/".join(quote(str(segment), safe="") for segment in segments)
        try:
            with httpx.Client(base_url=self.base_url, headers={**self.headers, "Accept": accept}, auth=self.auth,
                              timeout=10, trust_env=False, transport=self.transport) as http:
                response = http.get(path, params=params)
                needs_login = (response.status_code in (401, 403) or response.is_redirect
                               or "text/html" in response.headers.get("content-type", ""))
                if needs_login and not self.token and self.username and self.password:
                    self.login_airflow(http)
                    response = http.get(path, params=params)  # 原 GET 仅重试一次。
        except httpx.HTTPStatusError as error:
            raise ToolException(f"Airflow 登录认证失败（HTTP {error.response.status_code}）。") from None
        except httpx.TimeoutException:
            raise ToolException("Airflow 请求超时（10 秒）。") from None
        except httpx.HTTPError as error:
            raise ToolException(f"无法连接 Airflow：{type(error).__name__}。") from None
        if response.status_code in (401, 403):
            raise ToolException(f"Airflow 认证失败（HTTP {response.status_code}）："
                                "检查 TOKEN、账号密码，或 COOKIE 是否过期；也可能是 server 选错了。")
        if response.status_code == 404:
            raise ToolException("Airflow 找不到该资源（HTTP 404）：检查 dag_id、dag_run_id、task_id 是否正确。")
        if response.is_error:
            raise ToolException(f"Airflow 返回 HTTP {response.status_code}。")
        if response.is_redirect or "text/html" in response.headers.get("content-type", ""):
            raise ToolException("Airflow API 返回登录页或重定向，认证未生效。")
        return response


def _client(server: Server) -> AirflowClient:
    return AirflowClient.from_env(ENV_PREFIXES[server])


def _pick(item: dict, fields: tuple[str, ...]) -> dict:
    return {key: item[key] for key in fields if key in item}


def _page(body: dict, key: str, fields: tuple[str, ...], offset: int) -> dict:
    items = [_pick(item, fields) for item in body[key]]
    total = body["total_entries"]
    end = offset + len(items)
    return {"items": items, "total_entries": total, "next_offset": end if items and end < total else None}


def _auth_mode(prefix: str) -> str:
    def env(name: str) -> str:
        return os.environ.get(prefix + name, "")
    if env("TOKEN"):
        return "bearer"
    if env("COOKIE"):
        return "cookie"
    if env("USERNAME") and env("PASSWORD"):
        return "username_password"
    return "not_configured"


@tool
def airflow_connection_info() -> dict:
    """查看本地配置了哪些 Airflow 服务器和认证方式，不发网络请求、不返回密码/Cookie/token；配置存在不代表连通成功。用于回答“能查哪个 IP”。"""
    connections = []
    for server, prefix in ENV_PREFIXES.items():
        value = os.environ.get(prefix + "BASE_URL", "")
        try:
            parts = urlsplit(value)
            host = parts.hostname or ""
            if ":" in host:
                host = "[" + host + "]"
            address = host + (f":{parts.port}" if parts.port else "")
            sanitized = urlunsplit((parts.scheme, address, parts.path, "", "")) if value else None
        except ValueError:
            raise ToolException("Airflow 地址格式不合法，未返回配置。") from None
        connections.append({"server": server, "base_url": sanitized, "configured": bool(value),
                            "auth_mode": _auth_mode(prefix), "connectivity_verified": False})
    return {"connections": connections}


@tool(parse_docstring=True)
def airflow_list_dags(limit: int = 20, offset: int = 0, server: Server = "default") -> dict:
    """列出 Airflow 中的 DAG，分页返回。

    Args:
        limit: 本页条数，1–100。
        offset: 跳过的条数；翻页时传上次结果里的 next_offset。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
    """
    body = _client(server).get("dags", params={"limit": limit, "offset": offset}).json()
    return _page(body, "dags", DAG_FIELDS, offset)


@tool(parse_docstring=True)
def airflow_get_dag(dag_id: str, server: Server = "default") -> dict:
    """查询单个 DAG 的配置：是否暂停、调度周期、标签等。

    Args:
        dag_id: DAG ID。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
    """
    return {"dag": _pick(_client(server).get("dags", dag_id).json(), DAG_FIELDS)}


@tool(parse_docstring=True)
def airflow_list_runs(dag_id: str, limit: int = 20, offset: int = 0, server: Server = "default") -> dict:
    """列出某个 DAG 的运行记录，最新的在前。

    Args:
        dag_id: DAG ID。
        limit: 本页条数，1–100。
        offset: 跳过的条数；翻页时传上次结果里的 next_offset。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
    """
    params = {"limit": limit, "offset": offset, "order_by": "-execution_date"}
    body = _client(server).get("dags", dag_id, "dagRuns", params=params).json()
    return _page(body, "dag_runs", RUN_FIELDS, offset)


@tool(parse_docstring=True)
def airflow_get_run(dag_id: str, dag_run_id: str, server: Server = "default") -> dict:
    """查询一次 DAG 运行的状态和起止时间。

    Args:
        dag_id: DAG ID。
        dag_run_id: 运行 ID，如 scheduled__2026-10-01T07:00:00+00:00；不确定时先用 airflow_list_runs 查。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
    """
    return {"run": _pick(_client(server).get("dags", dag_id, "dagRuns", dag_run_id).json(), RUN_FIELDS)}


@tool(parse_docstring=True)
def airflow_list_tasks(dag_id: str, dag_run_id: str, limit: int = 50, offset: int = 0,
                       server: Server = "default") -> dict:
    """列出一次运行里所有任务实例的状态，用来找失败的任务。

    Args:
        dag_id: DAG ID。
        dag_run_id: 运行 ID。
        limit: 本页条数，1–100。
        offset: 跳过的条数；翻页时传上次结果里的 next_offset。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
    """
    body = _client(server).get("dags", dag_id, "dagRuns", dag_run_id, "taskInstances",
                         params={"limit": limit, "offset": offset}).json()
    return _page(body, "task_instances", TASK_FIELDS, offset)


@tool(parse_docstring=True)
def airflow_get_task(dag_id: str, dag_run_id: str, task_id: str, map_index: int | None = None,
                     server: Server = "default") -> dict:
    """查询单个任务实例的状态和 try_number（读日志前需要它）。

    Args:
        dag_id: DAG ID。
        dag_run_id: 运行 ID。
        task_id: 任务 ID。
        map_index: 仅动态映射任务需要，指定第几个映射实例。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
    """
    segments = ["dags", dag_id, "dagRuns", dag_run_id, "taskInstances", task_id]
    if map_index is not None:
        segments.append(map_index)
    return {"task": _pick(_client(server).get(*segments).json(), TASK_FIELDS)}


@tool(parse_docstring=True)
def airflow_get_task_log(dag_id: str, dag_run_id: str, task_id: str, try_number: int,
                         map_index: int | None = None, server: Server = "default",
                         offset: Annotated[int, Field(ge=-1)] = -1,
                         max_chars: Annotated[int, Field(ge=1, le=12000)] = 12000,
                         export_log: bool = False,
                         keyword: Annotated[str | None, Field(min_length=1)] = None,
                         context_lines: Annotated[int, Field(ge=0, le=100)] = 20) -> dict:
    """读取日志末尾、指定片段或关键词附近原文，支持导出本地日志。

    Args:
        dag_id: DAG ID。
        dag_run_id: 运行 ID。
        task_id: 任务 ID。
        try_number: 第几次尝试，从 1 开始；最近一次的值见 airflow_get_task 返回的 try_number。
        map_index: 仅动态映射任务需要，指定第几个映射实例。
        server: default 为默认 Airflow；automation 为广告自动化 Airflow（scs_take_rate_ads 等）。
        offset: -1 读取末尾；0 从头读取，之后传 next_offset。
        max_chars: 本次返回字符数，1–12000。
        export_log: 是否把已获取的完整日志保存本地；仅保存，不修改 Airflow。
        keyword: 可选关键词，不区分大小写的字面匹配；指定后忽略 offset，返回匹配片段及原始行号。未匹配不代表没有错误。
        context_lines: 关键词匹配行前后各保留多少行，0–100；片段正文合计仍受 max_chars 限制。
    """
    params = {"map_index": map_index} if map_index is not None else None
    client = _client(server)
    text = client.get("dags", dag_id, "dagRuns", dag_run_id, "taskInstances", task_id, "logs", try_number,
                         params=params, accept="text/plain").text
    result = {"try_number": try_number, "map_index": map_index, "server": server,
              "total_chars": len(text),
              "source": f"{client.base_url}/dags/{quote(dag_id, safe='')}/dagRuns/{quote(dag_run_id, safe='')}/taskInstances/{quote(task_id, safe='')}/logs/{try_number}"}
    if keyword is None:
        start = max(0, len(text) - max_chars) if offset == -1 else offset
        end = min(len(text), start + max_chars)
        result.update(log=text[start:end], truncated=start > 0 or end < len(text),
                      offset=start, next_offset=end if end < len(text) else None)
    else:
        lines = text.splitlines(keepends=True)
        hits = [i for i, line in enumerate(lines) if keyword.casefold() in line.casefold()]
        ranges = []
        for i in hits:
            start, end = max(0, i - context_lines), min(len(lines), i + context_lines + 1)
            if ranges and start <= ranges[-1][1]:
                ranges[-1][1] = max(ranges[-1][1], end)
            else:
                ranges.append([start, end])
        snippets, remaining = [], max_chars
        truncated = False
        for start, end in ranges:
            excerpt = "".join(lines[start:end])
            chunk = excerpt[:remaining]
            truncated = truncated or len(chunk) < len(excerpt)
            if chunk:
                snippets.append({"start_line": start + 1, "end_line": start + len(chunk.splitlines()), "log": chunk})
            remaining -= len(chunk)
        result.update(keyword=keyword, matched_lines=len(hits), snippets=snippets, truncated=truncated)
    if export_log:
        if len(text.encode()) > 2_000_000:
            raise ToolException("日志超过 2 MB，本次不导出；请缩小日志范围。")
        root = DATA_DIR / "check-logs"
        root.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(text.encode()).hexdigest()
        path = root / f"{digest}.log"
        path.write_text(text)
        path.chmod(0o600)
        result.update(local_path=str(path), sha256=digest,
                      note="文件包含本次 API 返回的日志；未保证后续运行追加内容也已获取。")
    return result


AIRFLOW_TOOLS = [airflow_connection_info, airflow_list_dags, airflow_get_dag, airflow_list_runs, airflow_get_run,
                 airflow_list_tasks, airflow_get_task, airflow_get_task_log]
for _tool in AIRFLOW_TOOLS:
    # ToolException messages go back to the model as an error ToolMessage instead of failing the run.
    _tool.handle_tool_error = True
