import { AppError } from "./session-store.js";

export type LimitConfig = { perMinute: number; burst: number; maxConcurrent?: number };
export const DEFAULT_MODEL_LIMIT: LimitConfig = { perMinute: 60, burst: 12, maxConcurrent: 4 };
export const DEFAULT_GATEWAY_LIMITS = {
  global: { perMinute: 600, burst: 100 },
  connection: { perMinute: 120, burst: 40 },
  session: { perMinute: 20, burst: 8 },
};
export type GatewayLimitConfig = typeof DEFAULT_GATEWAY_LIMITS;

/** Monotonic token bucket. Reservations count actual requests, not queued Runs. */
export class RequestLimiter {
  private tokens: number;
  private updated: number;
  private active = 0;
  private accepted = 0;
  private rejected = 0;

  constructor(readonly config: LimitConfig, private readonly clock: () => number = () => performance.now()) {
    if (!Number.isInteger(config.perMinute) || config.perMinute < 1 || !Number.isInteger(config.burst) || config.burst < 1 ||
      config.maxConcurrent !== undefined && (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1)) {
      throw new AppError("INVALID_CONFIG", "限流配置必须是正整数。");
    }
    this.tokens = config.burst; this.updated = clock();
  }

  private refill(): void {
    const now = this.clock();
    this.tokens = Math.min(this.config.burst, this.tokens + Math.max(0, now - this.updated) * this.config.perMinute / 60_000);
    this.updated = Math.max(this.updated, now);
  }

  take(code = "RATE_LIMITED"): () => void {
    this.refill();
    if (this.config.maxConcurrent !== undefined && this.active >= this.config.maxConcurrent) {
      this.rejected++;
      throw new AppError("MODEL_BUSY", "模型活跃请求已达到并发上限，本次没有调用接口，请稍后重试。");
    }
    if (this.tokens < 1) {
      this.rejected++;
      const retryAfterMs = Math.ceil((1 - this.tokens) * 60_000 / this.config.perMinute);
      throw new AppError(code, `请求过于频繁，约 ${Math.ceil(retryAfterMs / 1000)} 秒后可重试；本次未执行。`, { retryAfterMs });
    }
    this.tokens -= 1; this.active++; this.accepted++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }

  snapshot() {
    this.refill();
    return { ...this.config, available: Math.floor(this.tokens), active: this.active,
      accepted: this.accepted, rejected: this.rejected };
  }
}

export class SessionRateLimits {
  private readonly buckets = new Map<string, { limiter: RequestLimiter; touched: number }>();
  constructor(private readonly config: LimitConfig, private readonly clock: () => number = () => performance.now()) {}
  take(sessionId: string): void {
    const now = this.clock();
    for (const [id, entry] of this.buckets) if (now - entry.touched > Math.max(300_000, this.config.burst * 60_000 / this.config.perMinute)) this.buckets.delete(id);
    let entry = this.buckets.get(sessionId);
    if (!entry) {
      if (this.buckets.size >= 1000) throw new AppError("RATE_LIMITED", "限流会话容量已满，请稍后重试。");
      entry = { limiter: new RequestLimiter(this.config, this.clock), touched: now }; this.buckets.set(sessionId, entry);
    }
    entry.touched = now; entry.limiter.take("SESSION_RATE_LIMITED")();
  }
}
