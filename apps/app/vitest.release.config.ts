import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "release",
    environment: "node",
    include: ["test/release/**/*.test.ts"],
    // `auth generate` を回すので既定の 5 秒では足りない。
    testTimeout: 120_000,
  },
});
