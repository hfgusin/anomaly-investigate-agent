"""
对应：src/rate-limit.ts

令牌桶：Gateway 全局/连接/会话限流，以及 LangChain 桥里的 model_request 并发。
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable


class AppError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


@dataclass
class LimitConfig:
    per_minute: int
    burst: int
    max_concurrent: int | None = None


DEFAULT_MODEL_LIMIT = LimitConfig(per_minute=60, burst=12, max_concurrent=4)
DEFAULT_GATEWAY_LIMITS = {
    "global": LimitConfig(per_minute=600, burst=100),
    "connection": LimitConfig(per_minute=120, burst=40),
    "session": LimitConfig(per_minute=20, burst=8),
}


class RequestLimiter:
    """与 TS RequestLimiter 相同算法；clock 默认 time.perf_counter * 1000 对齐 performance.now() 毫秒。"""

    def __init__(self, config: LimitConfig, clock: Callable[[], float] | None = None):
        if config.per_minute < 1 or config.burst < 1:
            raise AppError("INVALID_CONFIG", "限流配置必须是正整数。")
        if config.max_concurrent is not None and config.max_concurrent < 1:
            raise AppError("INVALID_CONFIG", "限流配置必须是正整数。")
        self.config = config
        self._clock = clock or (lambda: time.perf_counter() * 1000)
        self.tokens = float(config.burst)
        self.updated = self._clock()
        self.active = 0
        self.accepted = 0
        self.rejected = 0

    def _refill(self) -> None:
        now = self._clock()
        self.tokens = min(
            self.config.burst,
            self.tokens + max(0.0, now - self.updated) * self.config.per_minute / 60_000,
        )
        self.updated = max(self.updated, now)

    def take(self, code: str = "RATE_LIMITED") -> Callable[[], None]:
        self._refill()
        if self.config.max_concurrent is not None and self.active >= self.config.max_concurrent:
            self.rejected += 1
            raise AppError("MODEL_BUSY", "模型活跃请求已达到并发上限，本次没有调用接口，请稍后重试。")
        if self.tokens < 1:
            self.rejected += 1
            retry_after_ms = int((1 - self.tokens) * 60_000 / self.config.per_minute + 0.999)
            raise AppError(
                code,
                f"请求过于频繁，约 {retry_after_ms // 1000} 秒后可重试；本次未执行。",
                {"retryAfterMs": retry_after_ms},
            )
        self.tokens -= 1
        self.active += 1
        self.accepted += 1
        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self.active -= 1

        return release

    def snapshot(self) -> dict:
        self._refill()
        return {
            **self.config.__dict__,
            "available": int(self.tokens),
            "active": self.active,
            "accepted": self.accepted,
            "rejected": self.rejected,
        }


class SessionRateLimits:
    def __init__(self, config: LimitConfig, clock: Callable[[], float] | None = None):
        self.config = config
        self._clock = clock or (lambda: time.perf_counter() * 1000)
        self._buckets: dict[str, tuple[RequestLimiter, float]] = {}

    def take(self, session_id: str) -> None:
        now = self._clock()
        ttl = max(300_000, self.config.burst * 60_000 / self.config.per_minute)
        for sid, (_, touched) in list(self._buckets.items()):
            if now - touched > ttl:
                del self._buckets[sid]
        entry = self._buckets.get(session_id)
        if entry is None:
            if len(self._buckets) >= 1000:
                raise AppError("RATE_LIMITED", "限流会话容量已满，请稍后重试。")
            entry = (RequestLimiter(self.config, self._clock), now)
            self._buckets[session_id] = entry
        limiter, _ = entry
        self._buckets[session_id] = (limiter, now)
        limiter.take("SESSION_RATE_LIMITED")()
