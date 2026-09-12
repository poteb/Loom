import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    globalSetup: ["../core/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // vitest 4 removed `environmentMatchGlobs`; the DOM test picks happy-dom with a
    // `@vitest-environment` docblock instead, so the node-based tests stay on node.
    setupFiles: ["test/dom-setup.ts"],
  },
});
