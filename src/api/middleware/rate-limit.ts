import type { Context, Next } from "hono";
import { redis } from "../../db/index.js";
import { env } from "../../config/env.js";
import { problem } from "./error-handler.js";

export function rateLimit(kind: "api" | "auth") {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.req.header("authorization") ?? "anonymous";
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = kind === "auth" ? env.RATE_LIMIT_AUTH_PER_MINUTE : env.RATE_LIMIT_API_PER_MINUTE;
    const identity = kind === "auth" ? ip : auth;
    const key = `rl:${kind}:${identity}:${Math.floor(Date.now() / 60000)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    if (count > limit) return problem(c, 429, "Too Many Requests", "Rate limit exceeded");
    c.header("x-rate-limit-limit", String(limit));
    c.header("x-rate-limit-remaining", String(Math.max(0, limit - count)));
    await next();
  };
}
