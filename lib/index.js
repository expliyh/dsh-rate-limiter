import { Config, resolveProviders } from "./config.js";
import { RateLimiter } from "./limiter.js";
const name = "rate-limiter";
function apply(ctx, config) {
  const limiter = new RateLimiter();
  ctx.on("agent/request", async ({ signal }, next) => {
    const enabled = config.enabled.get();
    const callConfig = await next();
    if (!enabled) return callConfig;
    limiter.update(resolveProviders(config.providers.get()));
    await limiter.wait(callConfig.provider, signal);
    return callConfig;
  });
}
export {
  Config,
  apply,
  name,
  resolveProviders
};
