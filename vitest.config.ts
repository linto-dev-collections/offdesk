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
    ],
  },
});
