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
      reporter: ["text", "json", "html"],
      thresholds: { lines: 30, branches: 20, functions: 25, statements: 30 },
      exclude: ["dist/**", "public/**", "tests/**", "src/index.ts"]
    },
    testTimeout: 120000
  }
});
