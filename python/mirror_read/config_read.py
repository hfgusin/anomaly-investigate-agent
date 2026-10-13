"""
对应：src/config.ts 的 readConfig（简化：只解析环境变量，不实例化 TS 的 ToolRegistry）。

真实启动时 server.ts 会调用 readConfig(process.env, root) 拿到 port、runtime、sqlite 路径等。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .rate_limit import DEFAULT_GATEWAY_LIMITS, DEFAULT_MODEL_LIMIT, LimitConfig


class AppError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _limit(env: dict[str, str], key: str, fallback: int) -> int:
    value = int(env.get(key, str(fallback)))
    if value < 1 or value > 10_000:
        raise AppError("INVALID_CONFIG", f"{key} 必须是 1–10000 的整数。")
    return value


@dataclass
class ReadConfigResult:
    mode: str  # demo | chat-completions | responses
    agent_engine: str  # langchain | native
    port: int
    timeout_ms: int
    context_budget_chars: int
    database_path: Path
    gateway_limits: dict[str, LimitConfig]
    model_limits: LimitConfig | None


def read_config(env: dict[str, str] | None = None, root: str | Path | None = None) -> ReadConfigResult:
    env = env if env is not None else dict(os.environ)
    root = Path(root or Path(__file__).resolve().parents[2])

    gateway_limits = {
        "global": LimitConfig(
            per_minute=_limit(env, "GATEWAY_REQUESTS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS["global"].per_minute),
            burst=_limit(env, "GATEWAY_BURST", DEFAULT_GATEWAY_LIMITS["global"].burst),
        ),
        "connection": LimitConfig(
            per_minute=_limit(env, "CONNECTION_REQUESTS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS["connection"].per_minute),
            burst=_limit(env, "CONNECTION_BURST", DEFAULT_GATEWAY_LIMITS["connection"].burst),
        ),
        "session": LimitConfig(
            per_minute=_limit(env, "SESSION_SENDS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS["session"].per_minute),
            burst=_limit(env, "SESSION_SEND_BURST", DEFAULT_GATEWAY_LIMITS["session"].burst),
        ),
    }

    port = int(env.get("PORT", "18789"))
    timeout_ms = int(env.get("RUN_TIMEOUT_MS", "120000"))
    context_budget_chars = int(env.get("CONTEXT_BUDGET_CHARS", "120000"))
    if port < 1 or port > 65535:
        raise AppError("INVALID_CONFIG", "PORT 必须是 1–65535 的整数。")
    if timeout_ms < 1000 or timeout_ms > 600_000:
        raise AppError("INVALID_CONFIG", "RUN_TIMEOUT_MS 必须在 1000–600000 之间。")
    if context_budget_chars < 4096 or context_budget_chars > 200_000:
        raise AppError("INVALID_CONFIG", "CONTEXT_BUDGET_CHARS 必须在 4096–200000 之间。")

    mode = env.get("MIRROR_RUNTIME", "demo")
    agent_engine = env.get("AGENT_ENGINE", "langchain")
    if agent_engine not in ("langchain", "native"):
        raise AppError("INVALID_CONFIG", "AGENT_ENGINE 支持 langchain 或 native。")

    model_limits = None
    if mode in ("chat-completions", "responses"):
        if not (env.get("MODEL_BASE_URL") or "").strip():
            raise AppError("INVALID_CONFIG", "请在 .env 中填写 MODEL_BASE_URL。")
        model_limits = LimitConfig(
            per_minute=_limit(env, "MODEL_REQUESTS_PER_MINUTE", DEFAULT_MODEL_LIMIT.per_minute),
            burst=_limit(env, "MODEL_REQUEST_BURST", DEFAULT_MODEL_LIMIT.burst),
            max_concurrent=_limit(env, "MODEL_MAX_CONCURRENT", DEFAULT_MODEL_LIMIT.max_concurrent or 4),
        )
    elif mode != "demo":
        raise AppError("INVALID_CONFIG", "MIRROR_RUNTIME 支持 demo、chat-completions 或 responses。")

    data_dir = Path(env.get("MIRROR_DATA_DIR", root / ".data"))
    return ReadConfigResult(
        mode=mode,
        agent_engine=agent_engine,
        port=port,
        timeout_ms=timeout_ms,
        context_budget_chars=context_budget_chars,
        database_path=data_dir / "gateway.sqlite",
        gateway_limits=gateway_limits,
        model_limits=model_limits,
    )
