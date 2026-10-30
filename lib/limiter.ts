/**
 * 主动限速核心逻辑：按供应商的令牌桶（token bucket）。
 * 纯函数模块，不依赖 Cordis/ctx，可独立单元测试。
 *
 * Core rate-limiting logic: a token bucket per provider.
 * Pure function module with no Cordis/ctx dependency, independently unit-testable.
 */

export interface BucketOptions {
  /**
   * 补充速率（词元每秒），即长期平均 QPS。
   *
   * Refill rate (tokens/second), i.e. the long-term average QPS.
   */
  rate: number;
  /**
   * 桶容量，允许的突发请求数。
   *
   * Bucket capacity, the number of burst requests allowed.
   */
  burst: number;
}

/**
 * 令牌桶：预约式实现。
 *
 * 每个请求同步调用 {@link reserve} 预约一个 token，返回需等待的毫秒数。
 * 预约在 await 之前完成，因此并发请求各自排队、不会超发。
 *
 * simp: 取消等待的请求不会归还已预约的 slot，后续请求会多等（保守行为，
 * 更安全）。若需精确归还，可改为在取消时回退 nextAvailableAt。
 *
 * Token bucket: reservation-based implementation.
 *
 * Each request synchronously calls {@link reserve} to reserve a token and
 * receives the number of milliseconds to wait. Reservations complete before
 * any await, so concurrent requests queue independently and never over-issue.
 *
 * simp: a cancelled wait does not refund its reserved slot, so later requests
 * wait a bit longer (conservative and safer). For exact refunds, roll back
 * nextAvailableAt on cancellation instead.
 */
export class TokenBucket {
  private nextAvailableAt: number;
  private readonly intervalMs: number;
  private readonly burst: number;

  constructor(rate: number, burst: number) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`rate 必须为正数，收到 ${rate}`);
    }
    if (!Number.isInteger(burst) || burst < 1) {
      throw new Error(`burst 必须为正整数，收到 ${burst}`);
    }
    this.intervalMs = 1000 / rate;
    this.burst = burst;
    // 初始允许 burst 个请求立即放行
    // Initially allow `burst` requests to pass immediately.
    this.nextAvailableAt = Date.now() - (burst - 1) * this.intervalMs;
  }

  /**
   * 预约一个 token，返回需等待的毫秒数（0 表示立即放行）。
   *
   * Reserve a token and return the milliseconds to wait (0 = pass now).
   */
  reserve(): number {
    const now = Date.now();
    // 空闲恢复：桶最多恢复满（burst），即下次可用时刻最多提前到下限；
    // 不通过 Math.max(now, ...) 丢弃 burst 的追赶余量
    //
    // Idle recovery: the bucket refills at most up to (burst), i.e. the next
    // available time can advance at most down to the floor; the burst
    // catch-up allowance is kept instead of being dropped by Math.max(now, ...)
    this.nextAvailableAt = Math.max(
      this.nextAvailableAt,
      now - (this.burst - 1) * this.intervalMs,
    );
    const waitMs = Math.max(0, this.nextAvailableAt - now);
    this.nextAvailableAt += this.intervalMs;
    return waitMs;
  }
}

/**
 * 可取消的延迟等待。
 *
 * @returns 正常等待结束返回 true；signal 中止返回 false。
 *
 * Cancellable delayed wait.
 *
 * @returns true when the wait finishes normally; false when aborted by signal.
 */
export function cancellableDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A rate limiter managing one token bucket per provider.
 * Unconfigured providers pass through untouched (zero intrusion).
 *
 * The provider set is dynamic: update() applies live configuration changes
 * without resetting the reserved state of unchanged buckets, so a settings
 * edit takes effect on the next request and an in-flight queue keeps its
 * position unless that provider's rate or burst actually changed.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { options: BucketOptions; bucket: TokenBucket }>();

  /**
   * @param providers - initial per-provider bucket options.
   */
  constructor(providers: Record<string, BucketOptions> = {}) {
    this.update(providers);
  }

  /**
   * Apply the current provider configuration.
   *
   * Buckets are created for new providers, rebuilt when their rate or burst
   * changes, and removed together with providers that are no longer
   * configured. A bucket whose options are unchanged keeps its reserved state.
   *
   * @param providers - validated per-provider bucket options.
   */
  update(providers: Record<string, BucketOptions>): void {
    for (const provider of this.buckets.keys()) {
      if (!Object.hasOwn(providers, provider)) this.buckets.delete(provider);
    }
    for (const [provider, options] of Object.entries(providers)) {
      const current = this.buckets.get(provider);
      if (
        current !== undefined
        && current.options.rate === options.rate
        && current.options.burst === options.burst
      ) {
        continue;
      }
      this.buckets.set(provider, {
        options: { rate: options.rate, burst: options.burst },
        bucket: new TokenBucket(options.rate, options.burst),
      });
    }
  }

  /**
   * Wait until a token is available, then let the request through.
   *
   * @param provider - provider name carried by the call config.
   * @param signal - abort signal that cancels a queued wait.
   * @returns whether a wait occurred (i.e. the request was rate-limited).
   */
  async wait(provider: string, signal?: AbortSignal): Promise<boolean> {
    const entry = this.buckets.get(provider);
    if (entry === undefined) return false;
    const waitMs = entry.bucket.reserve();
    if (waitMs > 0) await cancellableDelay(waitMs, signal);
    return waitMs > 0;
  }
}