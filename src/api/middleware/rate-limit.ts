import type { Context, Next } from "hono";
import { redis } from "../../db/index.js";
import { env } from "../../config/env.js";
import { problem } from "./error-handler.js";

/**
 * Atomic token-bucket rate limiter via Redis Lua.
 *
 * Why a single Lua script (one round-trip, atomic)
 * -----------------------------------------------
 * The previous implementation did `INCR` then conditionally `EXPIRE`,
 * which is (a) two round-trips on the cold path and (b) a race: if the
 * process dies between INCR and EXPIRE the key has no TTL and the
 * bucket fills up forever. Lua scripts run atomically inside the Redis
 * server — INCR, conditional EXPIRE, and TTL read all happen as one
 * indivisible unit. ioredis's `defineCommand` caches the script SHA so
 * subsequent calls are EVALSHA (~0.3ms per invocation) instead of
 * shipping the script body every time.
 *
 * Algorithm
 * ---------
 * Fixed-window counter, sized to the configured per-minute limit:
 *   1. INCR key
 *   2. If new (count == 1), set TTL to the window length so the bucket
 *      auto-resets at the next minute boundary.
 *   3. Read remaining TTL for the X-RateLimit-Reset response header.
 *
 * For a true rolling-token-bucket (smoother burst handling), swap the
 * ARGV[2] (TTL seconds) for a token-refill computation; the script
 * shape is the same.
 */
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('TTL', KEYS[1])
local limit = tonumber(ARGV[1])
return {current, limit, math.max(0, limit - current), ttl}
`;

type RateLimitResult = [current: number, limit: number, remaining: number, ttlSeconds: number];

// Register the script once per process. `defineCommand` is idempotent —
// ioredis caches the SHA on first invocation, so subsequent calls are
// EVALSHA (single round-trip, ~0.3ms over a healthy link).
redis.defineCommand("rateLimitAtomic", {
  numberOfKeys: 1,
  lua: RATE_LIMIT_LUA,
});

export function rateLimit(kind: "api" | "auth") {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.req.header("authorization") ?? "anonymous";
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = kind === "auth" ? env.RATE_LIMIT_AUTH_PER_MINUTE : env.RATE_LIMIT_API_PER_MINUTE;
    const identity = kind === "auth" ? ip : auth;
    // Fixed window keyed by minute. The TTL on the Redis key auto-resets
    // the bucket at the next minute boundary — no janitor needed.
    const windowStart = Math.floor(Date.now() / 60_000);
    const key = `rl:${kind}:${identity}:${windowStart}`;
    const windowSeconds = 60;

    // Single round-trip: INCR + (EXPIRE if new) + TTL read, atomic on
    // the Redis side via the registered Lua script.
    const [current, limitOut, remaining, ttl] = await (
      redis as unknown as {
        rateLimitAtomic: (key: string, limit: number, ttl: number) => Promise<RateLimitResult>;
      }
    ).rateLimitAtomic(key, limit, windowSeconds);

    c.header("x-rate-limit-limit", String(limitOut));
    c.header("x-rate-limit-remaining", String(remaining));
    c.header("x-rate-limit-reset", String(Date.now() / 1000 + Math.max(ttl, 0)));

    if (current > limitOut) {
      c.header("retry-after", String(Math.max(ttl, 0)));
      return problem(c, 429, "Too Many Requests", "Rate limit exceeded");
    }
    await next();
  };
}