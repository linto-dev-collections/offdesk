import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/*
  画面のテスト（計画 P7a §5）。

  **workerd には DOM が無い**ので、`vitest.config.ts`（workers プール）とは
  別のプロジェクトにする。**切り分けはディレクトリ**（`test/client/`）——
  あちらが `exclude` で外し、ここが `include` で拾う。拡張子で分けると、
  JSX を持たない純粋な関数のテストを `.tsx` に置く羽目になる。

  `cloudflare()` プラグインは入れない（client 環境だけを組む）。
*/
export default defineConfig({
  plugins: [react()],
  test: {
    name: "client",
    environment: "jsdom",
    include: ["test/client/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/client/vitest.setup.ts"],
  },
});
