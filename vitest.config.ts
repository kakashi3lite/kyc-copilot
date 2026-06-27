import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Thresholds are intentionally low to match the current suite which
      // exercises the auth/rate-limit/graph-pipeline surface (see
      // tests/integration/api/auth.test.ts and tests/unit/services/browser).
      // Service modules (kyc-data adapters, billing stripe, webhooks) have
      // external dependencies and are tracked separately; ratchet up as
      // more unit tests land.
      thresholds: { lines: 35, branches: 50, functions: 30, statements: 35 },
      exclude: ["dist/**", "public/**", "tests/**", "src/index.ts"]
    },
    testTimeout: 120000
  }
});
