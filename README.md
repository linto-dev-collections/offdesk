# offdesk

Claude Code をリモート（Discord）から操作するためのアプリケーション。
Cloudflare Workers 1 本に静的アセットと Worker を載せ、D1 と R2 と Durable Object を 1 デプロイで扱う。

## 手を動かす前に

```bash
cp .env.example .env.local
cp apps/app/.env.example apps/app/.env.local
pnpm install
```

**`.env.local` は 2 つある。** 混ぜない。

| ファイル | 誰が読むか | 何を置くか |
| --- | --- | --- |
| `.env.local`（ルート） | `packages/infra/alchemy.run.ts` だけ | `ALCHEMY_PASSWORD` / `ALCHEMY_STAGE` / `CLOUDFLARE_*` |
| `apps/app/.env.local` | Vite・wrangler・`alchemy.run.ts` | **Worker が受け取るもの**（P1 以降） |

分けているのは、`@cloudflare/vite-plugin` が `apps/app/.env.local` の中身を `dist/<worker>/.dev.vars` へ**平文で書き出す**ため。
Worker が要らない秘密をビルド成果物に出さない。

## よく使うコマンド

| | |
| --- | --- |
| `pnpm dev` | ローカル開発（<http://localhost:5173>）。miniflare の D1 / R2 / DO を使う |
| `pnpm build` | 全パッケージのビルド |
| `pnpm deploy` | Cloudflare へデプロイ（**prod は CI から。手元から prod を出そうとすると止まる**） |
| `pnpm destroy` | そのステージのリソースを削除（**prod の D1 と R2 は消えない**） |

## デプロイ

**`main` への push で GitHub Actions が出す**（`.github/workflows/ci.yml`）。

```txt
install → knip → format:ci → check-types → depcruise → test → build → deploy
```

`deploy` は `push` かつ `main` のときだけ。PR では静的解析と build まで。
デプロイ後の確認（`/api/health` の本文と `content-type`、SPA、preview subdomain の非公開）は手で行う——手順は [plans/phase-00-skeleton.md](plans/phase-00-skeleton.md) §11-3。

CI に要る secret は 4 つ — `ALCHEMY_PASSWORD` / `ALCHEMY_STATE_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。

**手元から `prod` は出せない**（`alchemy.run.ts` が止める）。状態ストアが `ALCHEMY_DEPLOY` で切り替わるので、手元から打つと空の `.alchemy/` を正本として読み、すでに在る D1 と R2 を作り直しに行く。逃げ道はエラーメッセージに書いてある。

## 静的解析

```bash
pnpm knip && pnpm format && pnpm check-types && pnpm depcruise && pnpm test
```

`format` は書き換える（`biome check --write .`）。**CI は `format:ci`（`biome ci .`）** で差分を検出して落とす。

| | |
| --- | --- |
| `knip` | 使われていない依存・export・ファイル |
| `format` | 整形と lint（Biome） |
| `check-types` | 各パッケージの `tsc -b`（Project References） |
| `depcruise` | 依存の向き・循環・孤児（`.dependency-cruiser.cjs`） |
| `test` | 全プロジェクト（Vitest） |

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
  config/           tsconfig の共有設定
```

依存の向きは機械で強制しているので、破ると `pnpm depcruise` が落ちる。

## wrangler.jsonc と alchemy.run.ts の二重定義

`apps/app/wrangler.jsonc` は**ローカル開発専用**。デプロイ時のリソースとバインディングは `packages/infra/alchemy.run.ts` が正本で、`pnpm deploy` は wrangler.jsonc を読まない。

**バインディングを増やしたら 3 か所を揃える。**

1. `apps/app/wrangler.jsonc`（ローカル）
2. `packages/infra/alchemy.run.ts`（本番）
3. `apps/app/src/worker/env.ts` の `WorkerEnv`（型）
