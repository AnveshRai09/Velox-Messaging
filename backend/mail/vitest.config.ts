import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    silent: "passed-only",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
