import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Points XDG_CONFIG_HOME and XDG_CACHE_HOME at temp dirs for every file, so
    // no test can read the real ~/.config or write the real ~/.cache — see
    // tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
  },
});
