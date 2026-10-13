"""DI 安全重试中间件：只重试白名单里的读取，不重放 execute。"""
from dataclasses import dataclass
import datetime as dt
import time
from typing import Callable


class TransientDIError(ValueError):
    def __init__(self, kind, retry_after_ms=0):
        self.kind = kind
        self.retry_after_ms = retry_after_ms
        super().__init__(f"DI 读取遇到暂时性 {kind} 错误；本次重试未恢复，请用同一 query_id 核对。")


def is_safe_read(arguments):
    # 列出完整命令结构，不用“不是 execute 就安全”这样的反向判断。
    return (len(arguments) == 4 and arguments[:3] == ["livy", "interactives", "get"]) or (
        len(arguments) == 6 and arguments[:4] == ["livy", "interactives", "statements", "get"])


@dataclass
class DIRetryMiddleware:
    max_retries: int = 2
    budget_seconds: float = 35
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic

    def invoke(self, operation, arguments, job, persist):
        if not is_safe_read(arguments):
            return operation()  # 提交、停止、取消、未知命令都只调用一次。
        started = self.clock()
        for attempt in range(self.max_retries + 1):
            try:
                return operation()
            except TransientDIError as error:
                delay = max(2 ** attempt, error.retry_after_ms / 1000)
                retry = attempt < self.max_retries and self.clock() - started + delay + 10 <= self.budget_seconds
                job.setdefault("retry_events", []).append({
                    "at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "command": "session.get" if len(arguments) == 4 else "statement.get",
                    "statement_id": arguments[-1] if len(arguments) == 6 else None,
                    "attempt": attempt + 1, "reason": error.kind,
                    "will_retry": retry, "delay_seconds": delay if retry else 0,
                })
                if retry:
                    job["retry_count"] = job.get("retry_count", 0) + 1
                persist(job)
                if not retry:
                    raise
                self.sleep(delay)
