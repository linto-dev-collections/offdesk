# offdesk

Claude Code をリモート（Discord）から操作するためのアプリケーション。
Cloudflare Workers 1 本に静的アセットと Worker を載せ、D1 と R2 と Durable Object を 1 デプロイで扱う。

| | |
| --- | --- |
| [OPERATIONS.md](./OPERATIONS.md) | **運用手順。** 秘密の置き場・プロジェクトを増やす・cloud environment・困ったときに読む順 |
| [plugin/](./plugin/) | 配布物。このリポジトリは Claude Code の marketplace でもある |

**`docs/` と `plans/` は commit されない**（使い捨て。正本は現行のコード）。

## 手を動かす前に

```bash
cp .env.example .env.local
cp apps/app/.env.example apps/app/.env.local
pnpm install
```

**`.env.local` は 2 つある。** ルートは `alchemy.run.ts` だけが読み、`apps/app/` は Vite・wrangler・`alchemy.run.ts` が読む。
分けているのは `@cloudflare/vite-plugin` が `apps/app/.env.local` を `dist/<worker>/.dev.vars` へ**平文で書き出す**ため。

## よく使うコマンド

| | |
| --- | --- |
| `pnpm dev` | ローカル開発（<http://localhost:5173>）。miniflare の D1 / R2 / DO |
| `pnpm build` | 全パッケージのビルド |
| `pnpm routine:prompt` | routine に貼るプロンプトを出す |
| `pnpm deploy` | Cloudflare へ（**prod は CI から。手元から出そうとすると止まる**） |
| `pnpm destroy` | そのステージのリソースを削除（**prod の D1 と R2 は消えない**） |

プロジェクトの投入は GitHub Actions の `projects sync`（OPERATIONS.md §2）。

## 静的解析

```bash
pnpm knip && pnpm format && pnpm check-types && pnpm depcruise && pnpm test
```

`format` は書き換える。**CI は `format:ci`** で差分を検出して落とす。
`depcruise` が依存の向き（`.dependency-cruiser.cjs`）を機械で強制する。

## デプロイ

**`main` への push で GitHub Actions が出す。**

```txt
install → knip → format:ci → check-types → depcruise → test → build → deploy
```

CI に要る secret は 4 つ — `ALCHEMY_PASSWORD` / `ALCHEMY_STATE_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（Worker が受け取る値は
OPERATIONS.md §1）。

**手元から `prod` は出せない。** 状態ストアが `ALCHEMY_DEPLOY` で切り替わるので、手元から打つと空の `.alchemy/` を正本として読み、すでに在る D1 と R2 を作り直しに行く。逃げ道はエラーメッセージに書いてある。

## 構成

```txt
apps/app/           1 デプロイ単位
  src/client/       Vite + React + TanStack Router（SPA）
  src/worker/       Hono: oRPC / MCP / Discord / hooks / DO / cron
packages/
  contract/         oRPC の契約と Zod の DTO（依存の終着点）
  domain/           値オブジェクト・状態・遷移関数（依存ゼロ）
  usecase/          ユースケース 1 本 = 1 ファイル + port の宣言
  db/               Drizzle のスキーマ・マイグレーション・リポジトリ
  ui/               shadcn（`@workspace/ui`）
  infra/            alchemy.run.ts
plugin/             cloud session に入るプラグイン（marketplace はルート）
```

5 分ごとの cron が 2 つ動く —— Gateway の DO を起こす（**`fatal` なら何もしない**）と、`queued` のまま 10 分が過ぎた run を `failed` に畳む（**起こし直さない**）。

## wrangler.jsonc と alchemy.run.ts の二重定義

`apps/app/wrangler.jsonc` は**ローカル開発専用**。デプロイ時のリソースとバインディングは `packages/infra/alchemy.run.ts` が正本で、`pnpm deploy` は
wrangler.jsonc を読まない。

**バインディングを増やしたら 3 か所を揃える** —— `wrangler.jsonc`（ローカル）・`alchemy.run.ts`（本番）・`env.ts` の `WorkerEnv`（型）。
