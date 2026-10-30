/**
 * Plugin configuration schema and provider validation.
 *
 * The enabled and providers fields are volatile: dsh settings surfaces them in
 * the "Settings -> Plugins" form of the plugin row and applies edits live, so
 * apply receives stable Volatile references and reads the current snapshot
 * with get() instead of capturing the value once.
 */
import type { Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { BucketOptions } from "./limiter.js";

/** 单个供应商的令牌桶参数 */
export interface BucketConfig {
  /** 补充速率（词元每秒），即长期平均 QPS */
  rate: number
  /** 桶容量，允许的突发请求数 */
  burst: number
}

/** 单个供应商的令牌桶 schema */
export const BucketSchema = z.object({
  rate: z.number()
    .min(0.001)
    .description(
      "补充速率（词元每秒），即长期平均 QPS。"
      + " Refill rate (tokens/second), i.e. the long-term average QPS.",
    ),
  burst: z.natural()
    .min(1)
    .description(
      "桶容量，允许的突发请求数。"
      + " Bucket capacity, the number of burst requests allowed.",
    ),
}).i18n({
  "zh-CN": {
    rate: "速率（词元每秒）",
    burst: "突发容量",
  },
});

/** 插件配置接口（volatile 字段在 apply 收到时是稳定引用） */
export interface Config {
  /** 是否启用限速 */
  enabled: Volatile<boolean>
  /** 按供应商配置的令牌桶参数 */
  providers: Volatile<Record<string, BucketConfig>>
}

/** 插件配置 schema（Schemastery 校验，自动生成设置 UI） */
export const Config = z.object({
  enabled: z.boolean()
    .default(true)
    .description("启用/禁用限速插件。Enable or disable the rate limiter.")
    .volatile(),
  providers: z.dict(BucketSchema)
    .default({})
    .description(
      "按供应商名称配置限速参数，键名为供应商标识。"
      + " Rate-limit parameters per provider, keyed by provider name.",
    )
    .volatile(),
}).i18n({
  "zh-CN": {
    enabled: "启用限速",
    providers: "供应商限速配置",
  },
});

/**
 * Validate the live providers snapshot and project it to limiter options.
 *
 * The cordis Loader already validates the plugin config against Config; this
 * re-checks the values the limiter depends on because the snapshot can come
 * from a live settings edit. Absent or null means "no provider is
 * rate-limited".
 *
 * @param value - current providers snapshot (the get() result).
 * @returns validated per-provider bucket options.
 * @throws when providers is not an object or a rate/burst value is invalid.
 */
export function resolveProviders(value: unknown): Record<string, BucketOptions> {
  const providers: Record<string, BucketOptions> = {};
  if (value === undefined || value === null) return providers;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rate-limiter: providers must be an object keyed by provider name");
  }
  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    const options = (raw ?? {}) as Record<string, unknown>;
    const rate = options.rate;
    const burst = options.burst;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error('rate-limiter: provider "' + provider + '" rate must be a positive number');
    }
    if (typeof burst !== "number" || !Number.isInteger(burst) || burst < 1) {
      throw new Error('rate-limiter: provider "' + provider + '" burst must be a positive integer');
    }
    providers[provider] = { rate, burst };
  }
  return providers;
}
