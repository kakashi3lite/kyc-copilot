import type { Context, Next } from "hono";
import type { ZodSchema } from "zod";
import { problem } from "./error-handler.js";

export function validateJson<T>(schema: ZodSchema<T>) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem(c, 400, "Invalid request body", parsed.error.message);
    c.set("validated", parsed.data);
    await next();
  };
}

export function getValidated<T>(c: Context): T {
  return c.get("validated") as T;
}
