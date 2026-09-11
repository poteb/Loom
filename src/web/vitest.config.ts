import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../core/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
