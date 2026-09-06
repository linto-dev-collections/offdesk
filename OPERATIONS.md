# 運用手順

**半年後の自分が読む。** コードを読めば分かることは書かない —— 書くのは
**コードの外にあるもの**（claude.ai・Discord・Cloudflare の設定）と、
**触る順序**だけ。

> 設計の理由は各パッケージの why コメントにある。ここは「何をどの順に触るか」。

---

## 0-0. offdesk 自身が marketplace

**対象リポジトリには 1 バイトも置かない**（2026-09-06）。以前は 4 ファイルを写す運用（`repo-template/`）だった。

```txt
offdesk（public）
  .claude-plugin/marketplace.json   ← マニフェスト（**ルート必須**）
  plugin/plugins/offdesk/           ← プラグインの実物
        ↓ environment の setup script が install（§7-1）
cloud session
```

**鍵もミラーも CI の publish も無い。** 一時は public のミラー（`offdesk-plugin`）へ CI が押す形にしていたが、**別リポジトリへ push するには鍵が要る** —— `GITHUB_TOKEN` は走っているリポジトリにしか権限が無く、OIDC も GitHub 自身のトークンには変換されない。offdesk を public にすれば**押す先そのものが消える**ので、**ずれようがなくなる。**

**このリポジトリを private に戻すとプラグインが配れなくなる。** cloud session は routine の `sources` の外を**認証なしで**取りに行くため。戻すなら、公開のミラーと鍵を用意し直すことになる。

**`plugin/` の中は英語だけで書く**（このリポジトリの他の場所は日本語のまま）。誰の cloud session にも入りうるため —— `additionalContext` と `permissionDecisionReason` はモデルとログに出る文でもある。`release/pair-consistency.test.ts` が日本語の混入を止める。

**`hooks.json` のコマンドはシェルの 1 行。** JSON の中に埋めた `printf '…'` なので、**アポストロフィが 1 つ混ざるだけで構文エラー**になる（英語化のときに `repository's` で実際に踏んだ）。落ちてもセッションは進むので、症状は「承認が出ない」「残量が出ない」だけ —— `release/hook-template.test.ts` が**全部のコマンドを実際に走らせて**止める。

> **ツール名の接頭辞が経路で変わる**（2026-09-05 に実測）。プラグイン経由は `mcp__plugin_offdesk_offdesk__ask_human`、repo の `.mcp.json` 経由は `mcp__offdesk__ask_human`。承認 hook の matcher は両方を拾う（`OFFDESK_TOOL_MATCHER`）—— 片方だけにすると**承認が効かず routine が静かに詰まる**（Discord が無音になるだけでエラーは出ない）。

---

## 0. 秘密がどこにあるか

**offdesk の秘密は 3 か所にしか無い。**

| 置き場 | 何が | 誰が読むか |
| --- | --- | --- |
| GitHub の secret | `ALCHEMY_PASSWORD` / `ALCHEMY_STATE_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` ＋ Worker の secret 全部 | CI（`.github/workflows/ci.yml`）→ Alchemy → Worker |
| 手元の `.env.local` 2 本 | 同じ値（ローカル開発用） | ルート = Alchemy CLI だけ／`apps/app/` = Vite・wrangler・Alchemy |
| claude.ai の cloud environment | `OFFDESK_TOKEN`（Worker と同じ値） | cloud session の中の MCP クライアントと hook |

**`.env.local` が 2 本ある理由は分離**（plans/security.md 脅威 4）。
`@cloudflare/vite-plugin` は `apps/app/.env.local` の中身を `dist/<worker>/.dev.vars` へ**平文で書き出す**ので、Worker が要らない秘密をそちらに置かない。

### Worker が受け取る値と、欠けたときの症状

**全部が秘密ではない。** `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_GUILD_ID` / `OWNER_DISCORD_USER_ID` は公開の値なので、Alchemy には secret ではなく変数として渡す（状態ファイルに平文で残る側）。

| 名前 | 何に使うか | 欠けると |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | セッションの署名 | **デプロイが止まる**（全ステージ必須） |
| `AUTH_ALLOWED_EMAILS` | ログインを許すメール | **デプロイが止まる**。空 ＝ 全拒否（要件 `I-2`） |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | **prod のデプロイが止まる** |
| `DISCORD_BOT_TOKEN` | Gateway の identify・REST | Discord 経路が全部止まる（デプロイは通る） |
| `DISCORD_PUBLIC_KEY` | interaction の Ed25519 検証 | `/discord/interactions` が 503 |
| `DISCORD_APPLICATION_ID` | スラッシュコマンドの登録先 | `pnpm commands:register` が使えない |
| `DISCORD_GUILD_ID` | スレッド／チャンネルの URL を組む | 画面のリンクが出ない（**他は動く**）。公開の snowflake なので secret ではなく変数 |
| `OWNER_DISCORD_USER_ID` | 持ち主の判定（脅威 14） | 誰も `/offdesk` を使えない |
| `OFFDESK_TOKEN` | MCP・hooks・計画の置き口の Bearer | 全部 401 |
| `FIRE_TOKEN_KEY` | routine トークンの暗号化 | 起動できない。**変えると既存の暗号文が開けない** |
| `PLAN_LINK_SIGNING_KEY` | 計画リンクの署名 | `/p/*` が 401・`finish` が 503 |

**`FIRE_TOKEN_KEY` だけは回せない。** 変えると `project_fire_credentials` の暗号文が開かなくなる（`key_version` の分岐はあるが、旧鍵を捨てたら戻せない）。
回すなら**先に全プロジェクトのトークンを再発行**して `pnpm projects:sync` し直す。

### 秘密を差し替える

```sh
# 1. GitHub（本番の正本）
gh secret set OFFDESK_TOKEN

# 2. 手元（ローカル開発）
#    apps/app/.env.local の該当行を書き換える

# 3. 配り先があるものは同時に
#    OFFDESK_TOKEN … claude.ai の cloud environment にも同じ値を入れる（片方だけ変えると MCP が全部 401 になる）

# 4. デプロイ（main への push で走る）
git push
```

---

## 1. プロジェクトを増やす

**対象リポジトリには 1 バイトも置きません**（2026-09-06 に確立。§7-1 のプラグイン）。
以前は 4 ファイルを写す運用でした。

1. **claude.ai で routine を作る**。Repositories に対象リポジトリを 1 本だけ入れる
   （空だとクローンが無く、offdesk のツールが 1 つも見つからない）
2. **environment に `offdesk` を選ぶ**（§7 の設定が入っている方）。
   **新しい環境を作らない** —— 作ると setup script も環境変数も空なので、
   ツールが 1 つも載らない
3. プロンプトは `pnpm routine:prompt` の出力をそのまま貼る
4. **Discord にチャンネルを作る**（bot が見えること）
5. `projects.json` に 1 件足す（形は `projects.example.json`）
6. `gh secret set PROJECTS_JSON < projects.json` → GitHub Actions の
   **`projects sync`** を `dry_run=false` / `register_commands=true` /
   `guild_id=<サーバー id>` で回す
7. `/projects` の画面に出ること・トークンが `•••• ****` で出ることを見る
8. Discord で `/offdesk` の選択肢に出ることを見る（**`register_commands` が要る**
   —— 選択肢は登録時に焼き込まれる）

**`projects.json` は commit されない**（`.gitignore`）。fire トークンが入るため。

> **リポジトリは空にしないこと。** コミット 0 のリポジトリはデフォルトブランチが
> 無く、clone した先に HEAD が無いので、プラグインとは無関係な理由で失敗する。
> `README.md` 1 枚でよい。

---

## 2. トークンを差し替える

1. claude.ai の routine でトークンを再発行
2. `projects.json` の `fireToken` を書き換える
3. `pnpm projects:sync`（**暗号化は Worker の中で行う**。手元に鍵は要らない）
4. `/projects` の末尾 4 文字が変わったことを見る

**投入 CLI は送る前に実際に叩いて確かめる**（`check-token.ts`）。
「それらしい置き換え文字列」は Zod をすり抜けるので、形ではなく疎通で見る。

---

## 3. Gateway が落ちた

**症状**: スレッドに書いても何も起きない（コマンドは効く）。

1. `/operations` を開く
2. **`fatal` なら直し方が画面に出ている**。設定を直してから「張り直す」（直さずに押しても同じ理由で切られる）
3. `fatal` でなければ「張り直す」を押す（**60 秒に 1 回**まで）

| `fatalReason` | 直すところ |
| --- | --- |
| `close_4004` | Developer Portal で Reset Token → `DISCORD_BOT_TOKEN` を入れ直す |
| `close_4014` | Developer Portal → Bot → **MESSAGE CONTENT INTENT** を on |
| `no_token` | `DISCORD_BOT_TOKEN` が未設定 |

**5 分 cron が起こし直す**ので、一時的な切断は放っておけば戻る。
`fatal` だけは戻らない（要件 `F-I4`。張り続けると identify のレート制限を使い切る）。

`curl` で見るなら:

```sh
curl -H "authorization: Bearer $OFFDESK_TOKEN" https://<worker>/gateway/status
```

---

## 4. デプロイ

**`main` への push で GitHub Actions が出す。** 手元から prod は出せない。

```txt
install → knip → format:ci → check-types → depcruise → test → build → deploy
```

**握りは前の版のまま走り続ける**（最長 15 分）。Cloudflare の deploy は実行中のリクエストを打ち切らないので、**直したことを確かめるにはセッションを起こし直す。**

移行（マイグレーション）は Alchemy が deploy の中で流す。

---

## 5. 環境変数を足す

**3 か所を揃える。** 揃っていないことはテストが落として教える。

1. `apps/app/src/worker/env.ts` の `WorkerEnv`（型）＋ 一覧のどちらかへ
   - `PRODUCTION_REQUIRED_ENV_NAMES` … **欠けたらデプロイが止まる**
   - `ENDPOINT_GATED_ENV_NAMES` … 欠けても止まらない（その入口だけが黙る）
2. `packages/infra/alchemy.run.ts`（同じ一覧 ＋ `bindings`）
3. `apps/app/.env.example`（設定する人が読むのはここ）

さらに `.github/workflows/ci.yml` に `NAME: ${{ secrets.NAME }}` か `${{ vars.NAME }}` を足す。

**バインディング**（D1 / R2 / DO）を足すときは `apps/app/wrangler.jsonc`（ローカル専用）にも同じものを足す。

---

## 6. マイグレーション

```sh
pnpm -F @offdesk/db db:generate
```

**生成された SQL を目で読む。** 見るのは 2 つ:

- `DROP TABLE` … 列の変更で Drizzle が作り直しに来ていないか
- 外部キーの `CASCADE` … offdesk の FK は全部 `RESTRICT`（テーブル定義書 §7-2）

本番に何が入っているかは（参照のみ）:

```sh
wrangler d1 execute offdesk-db-prod --remote --command \
  "SELECT * FROM d1_migrations ORDER BY id"
```

---

## 7. cloud environment の設定（claude.ai 側）

**コードから見えないので、ここが唯一の記録。**

| 置き場 | 値 | 無いと |
| --- | --- | --- |
| Allowed domains | Worker のホスト名（**スキーム無し**） | MCP の接続失敗が「Authorization が拒否された」に化ける。読むべきは `request blocked: no rule or allowlist` |
| 環境変数 | `OFFDESK_URL` = `https://<worker>` | 繋がらない |
| 環境変数 | `OFFDESK_TOKEN` = Worker の secret と同じ値 | 全部 401 |
| 環境変数 | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` | 質問を出した直後に Claude が**勝手に先へ進む**（2 分でツール呼び出しが背後へ回る） |
| 環境変数 | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=3600000` | **5 分 00 秒ちょうどで握りが落ちる**（`ASK_HOLD_MS` より大きくする） |

### 7-1. Setup script（プラグインを入れる。**これが唯一の入口**）

**対象リポジトリに 1 バイトも置かずに offdesk のツールを載せる仕組み。**
environment の **Setup script** 欄に貼る。

```bash
#!/bin/bash
# offdesk のプラグインを入れる（対象リポジトリには 1 バイトも置かない）。
# 版: 1   ← プラグインを更新したらこの数字を上げる（キャッシュが作り直される）

set -u

# **root で走るので HOME が session と違うことがある。** 両方に入れて取りこぼさない。
for home in /home/user /root; do
  [ -d "$home" ] || continue
  HOME="$home" claude plugin marketplace add linto-dev-collections/offdesk || true
  HOME="$home" claude plugin install offdesk@offdesk || true
done

exit 0
```

**3 つの制約を織り込んである。** 素の 2 行に戻すと壊れる:

| 制約 | 対応 |
| --- | --- |
| **非ゼロで終わるとセッションが起動しない** | `\|\| true` と `exit 0`。marketplace が既に登録済みで 2 回目に非ゼロを返した瞬間、**セッションが起動しなくなる** |
| **root として走る** | `HOME` を明示。root の `$HOME` は `/root` だが session の作業場所は `/home/user/…` —— `~/.claude/plugins/` に入れないと Claude Code が見つけない |
| 5 分以内 | 問題なし（git の fetch 2 回） |

### 7-2. プラグインを更新したら「版」を上げる

**setup script は毎回走らない。** 環境のキャッシュが効く:

```txt
1 回目の session  → setup script が走る → プラグインが入る → スナップショット
2 回目以降        → スナップショットから起動（setup script は走らない）
```

キャッシュが作り直されるのは **setup script を変えたとき / 許可ドメインを変えた
とき / 約 7 日で期限切れ**のときだけ。**`plugin/` を直しても、
放っておくと最長 1 週間は古い版が使われる。**

**直したら `# 版: N` の数字を上げて保存する。** それだけでキャッシュが作り直される。

### 7-3. claude.ai のアカウントにプラグインを入れない

**入れても効かず、将来 2 つ載る危険がある。**

公式ドキュメントは「アカウントで有効にしたプラグインは cloud session の
`~/.claude/plugins/synced/` に降りてくる」と書いているが、**この組織では
降りてこない**（2026-09-05 に実測。ディレクトリとバケットの印は作られるのに
中身が空 —— 同期の機構はアカウントを解決したうえで 0 件を配っている。
`claude_team` の `user` ロールなので組織の方針で止まっている可能性が高い）。

もし将来有効になると **同じプラグインが 2 つ載る**（`offdesk@synced` と
`offdesk@offdesk`）—— MCP サーバーが 2 系統出て hook が 2 回鳴る。
壊れはしないが、切り分けの邪魔になる。**入口は setup script 1 つに保つ。**

**切り分けは「存在しない `run_key` で `ask_human` を 1 回だけ呼ばせる」のが速い**
—— Discord に触れずに、許可ドメイン・環境変数・MCP 認証・ツール発見・承認までを一度に確かめられる。

### Discord 側（Developer Portal）

| 置き場 | 値 |
| --- | --- |
| Interactions Endpoint URL | `https://<worker>/discord/interactions`（**先にデプロイしておく**。保存時に署名検証を試す） |
| Privileged Gateway Intents | **MESSAGE CONTENT INTENT** を on |
| bot の招待権限 | View Channels / Send Messages / Create Public Threads / Send Messages in Threads / Embed Links / Add Reactions / Read Message History |

---

## 8. コストを見る

**常駐 DO が 1 つであること**が唯一の効く見張り。
outbound WebSocket は hibernation 非対応で、繋いでいる間ずっと duration 課金 ——
1 つで月 約 324,000 GB-s（Workers Paid の含有枠 400,000 の内側）で、**2 つ目を足すと超える。**

宣言が 1 つであることは `test/release/single-gateway.test.ts` が見張っている。
実体は Cloudflare のダッシュボードで確かめる（Durable Objects → 一覧）。

D1 のサイズ（参照のみ）:

```sh
wrangler d1 list --profile <profile>
```

---

## 9. 人が測るもの

**自動テストで固められない 2 つ。** 測ったら**この表に書き足す**
（次に触るときの基準になる）。

| 何を | どう測るか | 実測 |
| --- | --- | --- |
| `A-5` 15 分の待ちで turn が 2 回に収まる | cloud session のログで、`ask_human` を挟んだ前後の turn 数を数える | 未測定 |
| `A-8` 実装計画をスマホから開いて読める | 実機で `/p/<plan_id>/` を開き、表・相互リンク・山括弧の地の文を見る | 未測定 |

---

## 10. 困ったときに読む順

| 症状 | 先に見るところ |
| --- | --- |
| スレッドに書いても何も起きない | `/operations` の Gateway の状態（§3） |
| コマンドが届かない | Developer Portal の Interactions Endpoint URL（§7） |
| MCP のツールが 1 つも見つからない | **environment が `offdesk` か**（§1 の 2）。次に `claude plugin list` が空でないか（§7-1 の setup script）。空なら setup script を保存し直してキャッシュを作り直す |
| プラグインを直したのに古い挙動 | 環境のキャッシュ。**`# 版: N` を上げる**（§7-2） |
| 承認待ちで固まる | プラグインの `hooks/hooks.json` の `PreToolUse`（§7-1 の setup script が入っているか） |
| 5 分ちょうどで握りが落ちる | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`（§7） |
| 質問の直後に Claude が先へ進む | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`（§7） |
| `queued` のまま止まっている | 10 分で cron が `failed` に畳む。畳まれたら書き直せば新しい run が立つ |
| 計画の URL が 401 | `PLAN_LINK_SIGNING_KEY`（§0） |
| デプロイしたのに直らない | 握りが前の版のまま走っている（§4） |
| API が HTML を返す | `run_worker_first` の載せ忘れ（テストが落ちるはず） |
