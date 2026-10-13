"""
对应：src/protocol.ts

Gateway WebSocket 上客户端发的每条消息应是合法 JSON，且符合 GatewayRequest 形状。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, TypedDict, Union


@dataclass(frozen=True)
class GatewayRequest:
    type: Literal["req"]
    id: str
    method: str
    params: dict[str, Any] | None = None


class GatewayOk(TypedDict):
    type: Literal["res"]
    id: str
    ok: Literal[True]
    payload: Any


class GatewayErr(TypedDict):
    type: Literal["res"]
    id: str
    ok: Literal[False]
    error: dict[str, Any]


GatewayResponse = Union[GatewayOk, GatewayErr]


class GatewayEvent(TypedDict):
    type: Literal["event"]
    event: str
    payload: dict[str, Any]
    seq: int


def parse_request(value: Any) -> GatewayRequest | None:
    """与 TS parseRequest 相同：非法则返回 None，由 gateway 转成 INVALID_REQUEST。"""
    if not isinstance(value, dict):
        return None
    if value.get("type") != "req":
        return None
    req_id = value.get("id")
    method = value.get("method")
    if not isinstance(req_id, str) or not req_id or len(req_id) > 128:
        return None
    if not isinstance(method, str) or not method or len(method) > 128:
        return None
    params = value.get("params")
    if params is not None and (not isinstance(params, dict) or isinstance(params, list)):
        return None
    return GatewayRequest(type="req", id=req_id, method=method, params=params)
