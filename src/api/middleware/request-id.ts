import type { Context, Next } from "hono";
import { randomUUID } from "node:crypto";
import { requestContext } from "../../config/logger.js";

export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.header("x-request-id", requestId);
  await requestContext.run({ requestId }, next);
}
