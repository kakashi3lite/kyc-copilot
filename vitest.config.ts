import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // LLM mock setup file — replaces @langchain/* and DynamicLlmRouter
    // with deterministic stubs so CI never hits real OpenAI/Anthropic/
    // Google APIs. See tests/setup/llm-mock.ts for the rationale.
    setupFiles: ["./tests/setup/llm-mock.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      // Phase G — production hardening targets (verified 2026-08-03:
      // 61.4% stmts / 48.1% branch / 66.0% funcs / 62.5% lines).
      thresholds: { lines: 60, branches: 40, functions: 55, statements: 60 },
      exclude: ["dist/**", "public/**", "tests/**", "src/index.ts"]
    },
    testTimeout: 120000
  }
});
