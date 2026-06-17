import { AsyncLocalStorage } from "node:async_hooks";
import { pino } from "pino";
import { env } from "./env.js";
import { maskPiiInText, maskRecord } from "../utils/mask.js";

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  caseId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const logger = pino({
  level: env.LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    log(object) {
      return maskRecord(object as Record<string, unknown>);
    }
  },
  hooks: {
    logMethod(inputArgs, method) {
      const maskedArgs: unknown[] = inputArgs.map((arg: unknown) => typeof arg === "string" ? maskPiiInText(arg) : arg);
      return (method as (...args: unknown[]) => unknown).apply(this, maskedArgs) as never;
    }
  },
  redact: {
    paths: ["apiKey", "authorization", "password", "registrationNumber", "uboName", "secret", "token", "refreshToken"],
    censor: "[REDACTED]"
  }
});

export function childLogger(bindings: Record<string, string | number | boolean | undefined>): pino.Logger {
  const ctx = requestContext.getStore();
  return logger.child({ ...ctx, ...bindings });
}
