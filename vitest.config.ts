import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Points XDG_CONFIG_HOME at a temp dir for every file, so no test can read
    // the real ~/.config — see tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
  },
});
