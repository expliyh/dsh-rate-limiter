import type { Context } from "@deepseek-ai/cordis";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
// 加载 dsh-agent 对 Cordis Events 的模块扩展（编译期类型），
// 使 "agent/request" 挂载点获得精确的 payload/next 签名。
//
// Load dsh-agent's module augmentation of Cordis Events (compile-time types)
// so the "agent/request" mount point gets precise payload/next signatures.
import type {} from "@deepseek-ai/dsh-agent";
import { Config, resolveProviders } from "./config.js";
import { RateLimiter } from "./limiter.js";

export { Config, resolveProviders };
export const name = "rate-limiter";

/**
 * 主动限速插件：在 agent/request waterfall 中，先委托 next() 拿到含
 * 供应商的调用配置，再按供应商限速（不足则延迟排队而非失败），
 * 然后原样返回配置——不修改请求内容、不改路由、不吞错误。
 *
 * Proactive rate-limiter plugin: on the agent/request waterfall, delegate to
 * next() first to obtain the call config (which carries the provider), then
 * rate-limit per provider (queue with a delay instead of failing when tokens
 * run short), then return the config unchanged — never modify request content,
 * never change routing, never swallow errors.
 *
 * The config is read through its volatile references on every request, so
 * edits made in the plugin row's settings form (or in the profile patch
 * config) take effect on the next request without remounting the plugin.
 *
 * @param ctx - owning plugin context.
 * @param config - plugin config whose volatile fields are stable references.
 */
export function apply(ctx: Context, config: Config): void {
  const limiter = new RateLimiter();
  ctx.on("agent/request", async ({ signal }, next): Promise<LlmCallConfig> => {
    const enabled = config.enabled.get();
    const callConfig = await next();
    // enabled=false is zero intrusion: forward the call without rate-limiting.
    if (!enabled) return callConfig;
    limiter.update(resolveProviders(config.providers.get()));
    await limiter.wait(callConfig.provider, signal);
    return callConfig;
  });
}
