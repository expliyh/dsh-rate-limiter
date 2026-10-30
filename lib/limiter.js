class TokenBucket {
  nextAvailableAt;
  intervalMs;
  burst;
  constructor(rate, burst) {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`rate \u5FC5\u987B\u4E3A\u6B63\u6570\uFF0C\u6536\u5230 ${rate}`);
    }
    if (!Number.isInteger(burst) || burst < 1) {
      throw new Error(`burst \u5FC5\u987B\u4E3A\u6B63\u6574\u6570\uFF0C\u6536\u5230 ${burst}`);
    }
    this.intervalMs = 1e3 / rate;
    this.burst = burst;
    this.nextAvailableAt = Date.now() - (burst - 1) * this.intervalMs;
  }
  /**
   * 预约一个 token，返回需等待的毫秒数（0 表示立即放行）。
   *
   * Reserve a token and return the milliseconds to wait (0 = pass now).
   */
  reserve() {
    const now = Date.now();
    this.nextAvailableAt = Math.max(
      this.nextAvailableAt,
      now - (this.burst - 1) * this.intervalMs
    );
    const waitMs = Math.max(0, this.nextAvailableAt - now);
    this.nextAvailableAt += this.intervalMs;
    return waitMs;
  }
}
function cancellableDelay(delayMs, signal) {
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
class RateLimiter {
  buckets = /* @__PURE__ */ new Map();
  /**
   * @param providers - initial per-provider bucket options.
   */
  constructor(providers = {}) {
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
  update(providers) {
    for (const provider of this.buckets.keys()) {
      if (!Object.hasOwn(providers, provider)) this.buckets.delete(provider);
    }
    for (const [provider, options] of Object.entries(providers)) {
      const current = this.buckets.get(provider);
      if (current !== void 0 && current.options.rate === options.rate && current.options.burst === options.burst) {
        continue;
      }
      this.buckets.set(provider, {
        options: { rate: options.rate, burst: options.burst },
        bucket: new TokenBucket(options.rate, options.burst)
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
  async wait(provider, signal) {
    const entry = this.buckets.get(provider);
    if (entry === void 0) return false;
    const waitMs = entry.bucket.reserve();
    if (waitMs > 0) await cancellableDelay(waitMs, signal);
    return waitMs > 0;
  }
}
export {
  RateLimiter,
  TokenBucket,
  cancellableDelay
};
