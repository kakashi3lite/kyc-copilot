import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: { lines: 70, branches: 70, functions: 70, statements: 70 },
      exclude: ["dist/**", "public/**", "tests/**", "src/index.ts"]
    },
    testTimeout: 120000
  }
});
