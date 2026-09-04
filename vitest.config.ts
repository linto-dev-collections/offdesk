import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
      **設定ファイルのパスを明示する。** ディレクトリを指定すると、`apps/app` には
      `vite.config.ts`（Cloudflare プラグイン入りの本番ビルド用）と `vitest.config.ts`
      の両方があるため、どちらが選ばれるかが自明でない。

      フェーズが進むごとにここへ 1 行足していく。
    */
    projects: [
      "packages/contract/vitest.config.ts",
      "packages/domain/vitest.config.ts",
      "apps/app/vitest.config.ts",
      // 画面のテスト（P7a §5）。**workerd には DOM が無い**ので jsdom のプール。
      "apps/app/vitest.client.config.ts",
      // リリース前の関門（P1 §5）。設定ファイルとソースそのものを読むので node プール。
      "apps/app/vitest.release.config.ts",
    ],
  },
});
