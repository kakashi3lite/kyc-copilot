import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { childLogger } from "../../config/logger.js";
import type { ProblemDetails } from "../../types/index.js";

export function problem(c: Context, status: number, title: string, detail: string): Response {
  const body: ProblemDetails = { type: `https://kyc-copilot.local/problems/${status}`, title, status, detail, instance: c.req.path };
  return c.json(body, status as 400);
}

export function errorHandler(error: Error, c: Context): Response {
  const status = error instanceof HTTPException ? error.status : 500;
  const detail = status >= 500 ? "Internal server error" : error.message;
  childLogger({ component: "api" }).error({ error: error.message, path: c.req.path, status }, "request failed");
  return problem(c, status, status >= 500 ? "Internal Server Error" : "Request Error", detail);
}
