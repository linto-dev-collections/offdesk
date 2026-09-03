import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "domain",
    // 副作用を持たないパッケージなので Node 環境でよい。
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
