import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { childLogger } from "../config/logger.js";
import * as schema from "./schema.js";
import { withRetry } from "../utils/retry.js";

export type Database = NodePgDatabase<typeof schema>;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
export const db: Database = drizzle(pool, { schema });
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export async function checkDb(): Promise<boolean> {
  try {
    await withRetry(
      async () => {
        const client = await pool.connect();
        try {
          await client.query("select 1");
        } finally {
          client.release();
        }
      },
      { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    );
    return true;
  } catch (error) {
    childLogger({ component: "db" }).warn(
      { error: error instanceof Error ? error.message : String(error) },
      "database health check failed",
    );
    return false;
  }
}

export async function checkRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch (error) {
    childLogger({ component: "redis" }).warn(
      { error: error instanceof Error ? error.message : String(error) },
      "redis health check failed",
    );
    return false;
  }
}

export async function closeInfrastructure(): Promise<void> {
  await redis.quit();
  await pool.end();
}

// Run database health check on startup. Tolerate Fly Postgres cold-start
// latency (~30s window) before giving up. The migrate.ts release_command
// already validates DB connectivity before traffic is shifted; this
// runtime check is a defense-in-depth guard against later drift.
if (process.env.NODE_ENV !== "test" && process.env.SKIP_DB_CHECK !== "true") {
  const startupWindowMs = 30_000;
  const attempts = 30;
  const baseDelayMs = 250;
  const maxDelayMs = 2_000;

  withRetry(
    async () => {
      const client = await pool.connect();
      try {
        await client.query("select 1");
      } finally {
        client.release();
      }
    },
    { attempts, baseDelayMs, maxDelayMs },
  ).then(() => {
    childLogger({ component: "db" }).info("database reachable on startup");
  }).catch((error) => {
    childLogger({ component: "db" }).fatal({
      error: error instanceof Error ? error.message : String(error),
      windowMs: startupWindowMs,
    }, `Database health check failed after ${startupWindowMs}ms. Exiting.`);
    process.exit(1);
  });
}

