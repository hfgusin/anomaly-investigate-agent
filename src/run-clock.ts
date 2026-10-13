import { AppError } from "./session-store.js";

/** Execution budget pauses for human decisions; approval and wall deadlines remain bounded. */
export class RunClock {
  private executionMs = 0;
  private approvalSince: number | null = null;
  private last: number;
  private readonly started: number;
  constructor(private readonly executionLimit: number, private readonly approvalLimit = 600_000,
    private readonly totalLimit = 1_800_000, now = performance.now()) { this.started = this.last = now; }
  tick(waiting: boolean, now = performance.now()): AppError | undefined {
    const elapsed = Math.max(0, now - this.last); this.last = now;
    if (now - this.started >= this.totalLimit) return new AppError("RUN_DEADLINE", "任务达到 30 分钟总期限，请重新发起任务。");
    if (waiting) {
      this.approvalSince ??= now;
      if (now - this.approvalSince >= this.approvalLimit) return new AppError("APPROVAL_TIMEOUT", "等待审批超过 10 分钟，任务已结束。");
    } else {
      if (this.approvalSince === null) this.executionMs += elapsed;
      this.approvalSince = null;
      if (this.executionMs >= this.executionLimit) return new AppError("TIMEOUT", `任务累计执行超过 ${this.executionLimit / 1000} 秒（模型与工具共用，不含等待审批的时间）。`);
    }
    return undefined;
  }
}
