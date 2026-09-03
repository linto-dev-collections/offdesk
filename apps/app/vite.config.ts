import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  /*
    既定の "VITE_" を外す（plans/security.md 脅威 4）。

    `.env.local` は wrangler（Worker の env）と Vite（クライアント）の両方が読む
    ファイルで、既定のままだと接頭辞 1 つでシークレットがブラウザのバンドルに
    焼き込まれる。**クライアントへ渡す環境変数は 1 つも無い**ので、
    誰も使っていない接頭辞に付け替えて経路ごと塞ぐ。
  */
  envPrefix: "OFFDESK_PUBLIC_",
  plugins: [
    // ルート生成は react より前（生成物を react が読む）。
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/client/routes",
      generatedRouteTree: "./src/client/routeTree.gen.ts",
      quoteStyle: "double",
      semicolons: true,
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    /*
      Worker（src/worker）を Cloudflare ランタイムで動かす。client 環境とは
      モジュールグラフが分かれるので、client から `cloudflare:workers` に到達する
      import があればここでビルドが落ちる（脅威 4 の 2 層目）。

      ローカル開発は `wrangler.jsonc` を読む。デプロイ時のバインディングは
      `packages/infra/alchemy.run.ts` が正本。
    */
    cloudflare(),
  ],
  build: {
    // **outDir は指定しない。** @cloudflare/vite-plugin が環境ごとに
    // dist/client と dist/<worker-name> へ振り分けるため、上書きすると
    // dist/client/client のように二重になる。
    sourcemap: true,
  },
});
