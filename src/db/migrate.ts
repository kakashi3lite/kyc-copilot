/**
 * Database migration entrypoint — invoked by Fly.io's `release_command`.
 *
 * Why this exists
 * ---------------
 * `fly.toml:release_command = "node dist/src/db/migrate.js"` was added before
 * a corresponding source file existed. Without this script the release_command
 * fails with `Cannot find module '/app/dist/src/db/migrate.js'` on every
 * deploy, including cold starts. This script closes that gap.
 *
 * Why we don't use the `drizzle-kit migrate` CLI
 * ----------------------------------------------
 * `npm run db:migrate` shells out to `drizzle-kit migrate`, which lives in
 * devDependencies. The production Dockerfile runs `npm ci --omit=dev`, so
 * `drizzle-kit` is not present in the deployed image. Using the
 * programmatic migrator from `drizzle-orm/node-postgres/migrator` (a
 * production dependency) sidesteps that.
 *
 * Idempotency
 * -----------
 * `migrate()` reads `migrations/meta/_journal.json` and only applies
 * migrations whose hashes are not already in `drizzle.__drizzle_migrations`.
 * Safe to re-run on every deploy.
 *
 * Cold-start tolerance
 * --------------------
 * `Pool` is created with a 30-second connection timeout because Fly Postgres
 * can take several seconds to wake on cold start. The migrator's internal
 * retries handle transient `SELECT 1` failures.
 */

import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { logger } from "../config/logger.js";

const DEFAULT_MIGRATIONS_DIR = "/app/src/db/migrations";

function resolveMigrationsDir(): string {
  return process.env["MIGRATIONS_FOLDER"] ?? DEFAULT_MIGRATIONS_DIR;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    logger.fatal("DATABASE_URL is required for migrations");
    process.exit(1);
  }

  const migrationsFolder = resolveMigrationsDir();
  await mkdir(migrationsFolder, { recursive: true }).catch(() => {
    // mkdir of an existing dir throws EEXIST; that's fine.
  });

  logger.info({ migrationsFolder }, "running database migrations");

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    // Generous statement timeout — initial migration runs several CREATE TABLE statements.
    statement_timeout: 60_000,
  });

  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder });
    logger.info("database migrations complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.fatal({ error: message }, "database migrations failed");
    await pool.end().catch(() => {
      // best-effort close on failure
    });
    process.exit(1);
  }

  await pool.end();
  process.exit(0);
}

void main().catch((error: unknown) => {
  // Top-level guard: any unhandled rejection during startup.
  const message = error instanceof Error ? error.message : String(error);
  logger.fatal({ error: message }, "migrate.ts crashed");
  process.exit(1);
});