# 運用手順

**コードの外にあるものだけ**を書く（claude.ai・Discord・Cloudflare の設定と、触る順序）。
設計の理由は各パッケージの why コメントにある。

---

## 1. 秘密がどこにあるか

| 置き場 | 何が |
| --- | --- |
| GitHub の secret | `ALCHEMY_PASSWORD` / `ALCHEMY_STATE_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` ＋ 下の表の値 ＋ `PROJECTS_JSON` |
| 手元の `.env.local` 2 本 | 同じ値（ローカル開発用）。ルート = Alchemy CLI だけ／`apps/app/` = Vite・wrangler・Alchemy |
| claude.ai の cloud environment | `OFFDESK_URL` / `OFFDESK_TOKEN`（§3） |

**`.env.local` が 2 本ある理由**: `@cloudflare/vite-plugin` は `apps/app/.env.local` を `dist/<worker>/.dev.vars` へ平文で書き出す。Worker が要らない秘密をそちらに置かない。

### Worker が受け取る値

`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_GUILD_ID` / `OWNER_DISCORD_USER_ID` は公開の値なので、Alchemy には secret ではなく変数で渡す。

| 名前 | 欠けると |
| --- | --- |
| `BETTER_AUTH_SECRET` | **デプロイが止まる**（全ステージ必須） |
| `AUTH_ALLOWED_EMAILS` | **デプロイが止まる**。空 ＝ 全拒否 |
| `GOOGLE_CLIENT_SECRET` | **prod のデプロイが止まる** |
| `DISCORD_BOT_TOKEN` | Discord 経路が全部止まる（デプロイは通る） |
| `DISCORD_PUBLIC_KEY` | `/discord/interactions` が 503 |
| `DISCORD_APPLICATION_ID` | `/offdesk` を登録できない |
| `DISCORD_GUILD_ID` | 画面のリンクが出ない（他は動く） |
| `OWNER_DISCORD_USER_ID` | 誰も `/offdesk` を使えない |
| `OFFDESK_TOKEN` | MCP・hooks・計画の置き口が全部 401 |
| `FIRE_TOKEN_KEY` | 起動できない。**回せない**（変えると既存の暗号文が開かない。回すなら先に全プロジェクトのトークンを再発行して §2 の `update`） |
| `PLAN_LINK_SIGNING_KEY` | `/p/*` が 401・`finish` が 503 |

### 差し替える

```sh
gh secret set OFFDESK_TOKEN     # 1. 本番の正本
# 2. apps/app/.env.local の該当行も書き換える
# 3. OFFDESK_TOKEN は claude.ai の cloud environment にも同じ値を入れる（§3）
git push                        # 4. main への push でデプロイ
```

---

## 2. プロジェクトを増やす・直す・止める

GitHub Actions の **`projects sync`** を `workflow_dispatch` で回し、**1 つ選ぶ**。
触るものは**台帳**（D1 の `projects` 表）と **Discord の `/offdesk` の選択肢**の 2 つ。

| 選ぶもの | 台帳 | `/offdesk` | いつ |
| --- | --- | --- | --- |
| `check` | 書かない | 触らない | 迷ったら最初にこれ（既定） |
| `add` | 入れる | **更新する** | 増やすとき |
| `update` | 書き換える | 触らない | トークン差し替え・チャンネル変更 |
| `commands` | 触らない | **更新する** | 選択肢がずれた |

**`add` で `/offdesk` の更新が要る**: 選択肢は登録の時点で焼き込まれるので、台帳に入れただけでは Discord に新しい名前が出ない（画面には出るので気づきにくい）。

**`check` が書かないのは台帳だけ。** トークンは実際に Anthropic へ叩いて確かめる（セッションは作らない）。

### 増やす

1. claude.ai で **routine** を作る。Repositories は対象リポジトリ 1 本だけ
2. **environment に `offdesk` を選ぶ**（§3。新しい環境を作ると何も載らない）
3. プロンプトに `pnpm routine:prompt` の出力を貼る
4. Discord に**チャンネルを作る**（bot が見えること）
5. `projects.json` に 1 件足して `gh secret set PROJECTS_JSON < projects.json`
6. `projects sync` を `check` → 中身を読む → `add`
7. `/projects` に出ること・`/offdesk` の選択肢に出ることを見る

**対象リポジトリには 1 バイトも置かない**（§3-1 のプラグインが入る）。
ただし**空のリポジトリにしない** —— コミット 0 だとデフォルトブランチが無く、clone に失敗する。`README.md` 1 枚でよい。

### 直す

`projects.json` を書き換えて `update`。**名前は変えない** —— 名前が一致の鍵なので、変えると別のプロジェクトが増えて古い行が残る。

### 止める・消す

**このワークフローではできない**（削除の経路を持たず、`disabled_at` を書くコードも無い）。
止めるなら手で:

```sh
wrangler d1 execute offdesk-db-prod --remote --profile <profile> --command \
  "UPDATE projects SET disabled_at = unixepoch('subsec') * 1000 WHERE name = '<名前>'"
```

そのあと `commands` を回す（選択肢からは自動で消えない）。**消すのは想定していない**（`runs` が参照しているので、run の履歴ごと消すことになる）。

---

## 3. cloud environment（claude.ai 側）

**コードから見えないので、ここが唯一の記録。**

| 置き場 | 値 | 無いと |
| --- | --- | --- |
| Allowed domains | Worker のホスト名（**スキーム無し**） | MCP の失敗が「Authorization が拒否された」に化ける |
| 環境変数 | `OFFDESK_URL` = `https://<worker>` | 繋がらない |
| 環境変数 | `OFFDESK_TOKEN` = Worker の secret と同じ値 | 全部 401 |
| 環境変数 | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` | 質問の直後に Claude が勝手に先へ進む |
| 環境変数 | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=3600000` | **5 分ちょうどで握りが落ちる** |
| 環境変数 | `CLAUDE_CODE_EFFORT_LEVEL=xhigh` | **止まらない**（モデルの既定 `high` で走るだけ）。この表で唯一「無くても壊れない」行 |

Custom のネットワークにするときは「**Also include default list of common package managers**」にチェックを入れる（外すと `raw.githubusercontent.com` が塞がり、
下の setup script が失敗する）。

### 3-1. Setup script（プラグインを入れる。**唯一の入口**）

```bash
#!/bin/bash
# 版: 2   ← プラグインを直したらこの数字を上げる（キャッシュが作り直される）
set -u
for home in /home/user /root; do
  [ -d "$home" ] || continue
  HOME="$home" claude plugin marketplace add linto-dev-collections/offdesk || true
  HOME="$home" claude plugin install offdesk@offdesk || true
done
exit 0
```

- **`|| true` と `exit 0` を外さない** —— 非ゼロで終わるとセッションが起動しない
- **`HOME` を外さない** —— root で走るので `$HOME` が session と違う
- **claude.ai のアカウント側にプラグインを入れない** —— この組織では同期が届かず、将来届くと 2 つ載る
- **入ったかを cloud session の中から見るときは `claude plugin list`**（Bash 経由）。
  **`/plugin`（スラッシュ）は cloud session では使えない** —— 端末の UI 専用

### 3-2. effort（`CLAUDE_CODE_EFFORT_LEVEL`）

**routine のフォームに effort の欄は無い**（あるのはモデルセレクタだけ）。
指定する口は cloud environment の環境変数 1 つで、値は `low` / `medium` / `high` /
`xhigh` / `max` か `auto`。offdesk は **`xhigh`**（コードエージェント的な作業向け）。

- **これが最優先。** `CLAUDE_CODE_EFFORT_LEVEL` は `--effort` と `/effort` を**上書きする** ——
  置いたあとに人がセッションを開いて `/effort` で下げようとしても効かない
- **`max` は環境変数でしか永続しない**（セッション内で `max` にしてもその 1 回だけ）
- **環境は全プロジェクトで共通**なので、この値も全 routine に一律で効く。
  プロジェクトごとに変えたくなったら environment を分けることになり、
  `OFFDESK_URL` / `OFFDESK_TOKEN` / 許可ドメイン / setup script（＋`# 版: N`）が
  環境の数だけ二重管理になる。**いまは 1 つで足りる**
- Opus 5 に「最初に走らせた版の effort を保留する」挙動（Fable 5 / Opus 4.8 / 4.7 にある）は
  **無い**ので、`/effort` が `Not applied` になる罠は踏まない

### 3-3. プラグインを更新したら「版」を上げる

setup script は**毎回は走らない**（環境がキャッシュされ、2 回目以降は skip）。
`plugin/` を直しても、**放っておくと最長 1 週間は古い版**が使われる。
**`# 版: N` の数字を上げて保存する。**

### 3-4. Discord（Developer Portal）

| 置き場 | 値 |
| --- | --- |
| Interactions Endpoint URL | `https://<worker>/discord/interactions`（**先にデプロイする**） |
| Privileged Gateway Intents | **MESSAGE CONTENT INTENT** を on |
| bot の招待権限 | View Channels / Send Messages / **Create Public Threads** / Send Messages in Threads / Embed Links / Add Reactions / Read Message History |

**切り分けは「存在しない `run_key` で `ask_human` を 1 回呼ばせる」が速い**（Discord に触れずに、許可ドメイン・環境変数・MCP 認証・ツール発見・承認を一度に見る）。

---

## 4. Gateway が落ちた

**症状**: スレッドに書いても何も起きない（コマンドは効く）。

1. `/operations` を開く
2. **`fatal` なら直し方が画面に出ている。** 設定を直してから「張り直す」
3. `fatal` でなければ「張り直す」（**60 秒に 1 回**まで）

| `fatalReason` | 直すところ |
| --- | --- |
| `close_4004` | Developer Portal で Reset Token → `DISCORD_BOT_TOKEN` を入れ直す |
| `close_4014` | Developer Portal → Bot → MESSAGE CONTENT INTENT を on |
| `no_token` | `DISCORD_BOT_TOKEN` が未設定 |

一時的な切断は 5 分 cron が起こす。**`fatal` だけは人が直すまで戻らない。**

---

## 5. デプロイ

**`main` への push で GitHub Actions が出す。手元から prod は出せない。**

**握りは前の版のまま走り続ける**（最長 15 分）。直したことを確かめるにはセッションを起こし直す。

---

## 6. 環境変数を足す

3 か所を揃える（揃っていないとテストが落ちる）。

1. `apps/app/src/worker/env.ts` の `WorkerEnv` ＋ どちらかの一覧へ
   - `PRODUCTION_REQUIRED_ENV_NAMES` … 欠けたらデプロイが止まる
   - `ENDPOINT_GATED_ENV_NAMES` … 欠けても止まらない（その入口だけ黙る）
2. `packages/infra/alchemy.run.ts`（同じ一覧 ＋ `bindings`）
3. `apps/app/.env.example`

さらに `.github/workflows/ci.yml` に `${{ secrets.… }}` か `${{ vars.… }}` を足す。
バインディング（D1 / R2 / DO）なら `apps/app/wrangler.jsonc` にも。

---

## 7. マイグレーション

```sh
pnpm -F @offdesk/db db:generate
```

**生成された SQL を目で読む。** 見るのは `DROP TABLE`（作り直しに来ていないか）と外部キーの `CASCADE`（offdesk の FK は全部 `RESTRICT`）。

本番の適用状況（参照のみ）:

```sh
wrangler d1 execute offdesk-db-prod --remote --command \
  "SELECT * FROM d1_migrations ORDER BY id"
```

---

## 8. コストを見る

**常駐 DO が 1 つであること**が唯一の効く見張り。1 つで月 約 324,000 GB-s（含有枠 400,000 の内側）で、**2 つ目を足すと超える。**
宣言が 1 つであることは `release/single-gateway.test.ts` が見張る。
実体は Cloudflare のダッシュボード（Durable Objects）で確かめる。

---

## 9. 人が測るもの

自動テストで固められない 2 つ。**測ったらこの表に書き足す。**

| 何を | どう測るか | 実測 |
| --- | --- | --- |
| `A-5` 15 分の待ちで turn が 2 回に収まる | cloud session のログで turn 数を数える | 未測定 |
| `A-8` 実装計画をスマホから開いて読める | 実機で `/p/<plan_id>/` を開く | 未測定 |

---

## 10. 困ったときに読む順

| 症状 | 先に見るところ |
| --- | --- |
| スレッドに書いても何も起きない | Gateway の状態（§4） |
| コマンドが届かない | Interactions Endpoint URL（§3-4） |
| MCP のツールが 1 つも無い | environment が `offdesk` か（§2）。次に `claude plugin list`（§3-1）。**`.mcp.json` の `alwaysLoad: true`** も見る —— tool search が効くとツールの定義が遅延ロードになり、症状は同じ「無音」になる |
| プラグインを直したのに古い挙動 | キャッシュ。**`# 版: N` を上げる**（§3-3） |
| 承認待ちで固まる | プラグインの `hooks/hooks.json`（§3-1 が入っているか）。**routine は承認を出さない仕様になった**ので、この症状なら疑うのは人が開いて続けているセッションの側 |
| 5 分ちょうどで握りが落ちる | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`（§3） |
| 質問の直後に先へ進む | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`（§3） |
| セッションで `/effort` が効かない | 環境変数 `CLAUDE_CODE_EFFORT_LEVEL` が最優先だから（§3-2）。変えるなら環境の側 |
| `queued` のまま止まっている | 10 分で cron が畳む。書き直せば新しい run が立つ |
| 計画の URL が 401 | `PLAN_LINK_SIGNING_KEY`（§1） |
| 計画を置けない（`plans must live under …`） | **`publish-plan.sh` は `/tmp/offdesk-plans` の下しか受けない**（要件 `F-E10`）。Claude が別の場所に書いている |
| デプロイしたのに直らない | 握りが前の版のまま（§5） |
| API が HTML を返す | `run_worker_first` の載せ忘れ（テストが落ちるはず） |
