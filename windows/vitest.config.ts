// Headless island harness: `npm run test:harness`. Reuses vite.config (plugins, resolve, define).
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/harness/**/*.test.ts"],
    setupFiles: ["tests/harness/setup.ts"],
    restoreMocks: false,
  },
}));
