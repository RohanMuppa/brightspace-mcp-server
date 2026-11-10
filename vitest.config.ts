import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // No test may put a real notification on screen; notify tests pass their own env.
    env: { D2L_NOTIFY: "0" },
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/auth-cli.ts", "src/index.ts"],
    },
  },
});
