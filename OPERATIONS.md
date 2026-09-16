# 運用手順

**コードの外にあるものだけ**を書く（claude.ai・Discord・Cloudflare の設定と、触る順序）。
設計の理由は各パッケージの why コメントにある。

---

## 1. 秘密がどこにあるか

| 置き場 | 何が |
| --- | --- |
| GitHub の secret | `ALCHEMY_PASSWORD` / `ALCHEMY_STATE_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` ＋ 下の表の値 |
| 手元の `.env.local` 2 本 | 同じ値（ローカル開発用）。ルート = Alchemy CLI だけ／`apps/app/` = Vite・wrangler・Alchemy |
| claude.ai の cloud environment | `OFFDESK_URL` / `OFFDESK_TOKEN`（§3）。**`OFFDESK_ADMIN_TOKEN` は置かない** |

**`.env.local` が 2 本ある理由**: `@cloudflare/vite-plugin` は `apps/app/.env.local` を `dist/<worker>/.dev.vars` へ平文で書き出す。Worker が要らない秘密をそちらに置かない。

**fire トークン（routine の資格情報）はこの表に無い。** 置き場は D1 の `project_fire_credentials` だけで、平文はどこにも残らない —— 入れるのは `/projects` の画面から 1 回きりで、Worker が受け取ってすぐ `FIRE_TOKEN_KEY` で暗号化する。2026-09-16 まで手元の `projects.json` と GitHub secret の `PROJECTS_JSON` にも平文で在ったが、**両方消した**（§2）。

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
| `OFFDESK_ADMIN_TOKEN` | `/gateway/*` が Bearer で叩けない（画面からは通る） |
| `FIRE_TOKEN_KEY` | 起動できない。**回せない**（変えると既存の暗号文が開かない。回すなら先に全プロジェクトのトークンを再発行して §2 の「直す」） |
| `PLAN_LINK_SIGNING_KEY` | `/p/*` が 401・`finish` が 503 |

### 差し替える

```sh
gh secret set OFFDESK_TOKEN     # 1. 本番の正本
# 2. apps/app/.env.local の該当行も書き換える
# 3. OFFDESK_TOKEN は claude.ai の cloud environment にも同じ値を入れる（§3）
git push                        # 4. main への push でデプロイ
```

### トークンが 2 本ある理由

| 名前 | 開ける口 | 置き場 |
| --- | --- | --- |
| `OFFDESK_TOKEN` | `/mcp`・`/hooks/*`・`/plans/*` | Worker ＋ **cloud environment** |
| `OFFDESK_ADMIN_TOKEN` | `/gateway/status`・`/reset`・`/ensure` | Worker だけ |

**cloud environment の環境変数は「その環境を使う誰からも見える」**と公式が明記している（[cloud environments](https://code.claude.com/docs/en/cloud-environments)）。そして routine は**承認プロンプト無しで自律実行される**（[routines](https://code.claude.com/docs/en/routines)）。

つまりセッション側に置く値が開ける範囲は、そのまま「リポジトリ・PR・fetch した Web から入った 1 行が届く範囲」になる。`/gateway/reset` は常駐接続を落とし、identify のレート制限（1 日 1000 回）を消費する口なので、**セッションからは届かない側に置く。**

**2 本は必ず違う値にする。** 同じ値を入れると分離が消えるが、コードからは分かれて見えるので気付けない。

```sh
gh secret set OFFDESK_ADMIN_TOKEN   # openssl rand -base64 32
```

---

## 2. プロジェクトを増やす・直す・止める

**画面でやる**（`/projects`）。`projects.json` も GitHub Actions も要らない（2026-09-16 に畳んだ）。

台帳（D1 の `projects` 表）と **Discord の `/offdesk` の選択肢**の 2 つが動くが、**選択肢の登録し直しは画面が自動でやる** —— 増やした・止めた・戻したの直後に必ず走る。

**保存の前にトークンを実際に Anthropic へ叩いて確かめる**（セッションは作らない）。形だけ合っている置き換え文字列は Zod をすり抜けるので、実叩きが最後の門。

### 増やす

**先に claude.ai と Discord の側を作る。** ここは API が無いので画面には移せない（`/v1/claude_code/` の公開 API は `fire` の 1 本だけ）。

1. claude.ai で **routine** を作る。Repositories は対象リポジトリ 1 本だけ
2. **environment に `offdesk` を選ぶ**（§3。新しい環境を作ると何も載らない）
3. プロンプトを貼る —— **`/projects` の「routine に貼るプロンプト」からコピーする**
4. routine の **API トリガでトークンを発行**して控える（**1 度しか表示されない**）
5. Discord に**チャンネルを作る**
6. `/projects` の **「増やす」**に、名前・チャンネル・リポジトリ・fire の URL・トークンを入れて保存

**チャンネルは一覧から選ぶ。** 並ぶのは **bot が見えているチャンネルだけ**なので、出てこなければ bot が招かれていない（`/offdesk` の選択肢に出ないのと同じ原因）。

**名前は後から変えられない。** 一致の鍵なので、変えると別のプロジェクトが増えて古い行が残る —— 画面にも欄が無い。

**`ROUTINE_PROMPT` を直したら、既に在る routine 全部に貼り直す。** プロンプトは routine に焼き込まれるので、直しても勝手には届かない（**ズレても静かに動き続ける**）。逆に、ツールの説明・`initialize` の instructions・プラグインの skill は貼り直しが要らない —— 前者 2 つは Worker のデプロイで、skill は §3-1 の `# 版` を上げると届く。

**対象リポジトリには 1 バイトも置かない**（§3-1 のプラグインが入る）。
ただし**空のリポジトリにしない** —— コミット 0 だとデフォルトブランチが無く、clone に失敗する。`README.md` 1 枚でよい。

### 直す

行の **「直す」**。チャンネル・リポジトリ・fire の URL を書き換える。

**トークンは空欄なら据え置き。** claude.ai のトークンは 1 度しか表示されず、再発行すると前のものが失効するので、**入れ直しを強制しない**。入れたときだけ叩いて確かめ、通れば差し替わる。

**`fire の URL` は毎回入れ直す。** 一覧にはホストしか出ていない —— URL の末尾には routine の識別子が埋まっていて、**それ 1 つとトークンがあれば起動できる**ので、画面にも API の応答にも出していない。

> **別の routine を指すように URL を変えるときは、トークンも一緒に入れる。**
> 据え置きのまま URL だけ変えると、**前の routine のトークンが残る**（画面は止めない）。

### 止める・戻す

行の **「止める」**（無効なら「戻す」）。`disabled_at` が立ち、**そのチャンネルからは起動できなくなり、`/offdesk` の選択肢からも消える。**

**消す口は無い。** `runs.project_id` が `RESTRICT` の外部キーなので、run が 1 本でもあるプロジェクトは構造的に消せない —— 消せるようにすると run の履歴ごと消すことになる。

### `/offdesk` の選択肢がずれた

`/projects` の **「/offdesk を登録し直す」**。台帳は触らず、いま有効な名前で登録し直すだけ。

押すのは 2 つの場合 —— **option を増やしたとき**（`issue` / `pr` のような欄は登録し直すまで Discord に出ない）と、保存のときに「更新できませんでした」と出たとき。

---

## 3. cloud environment（claude.ai 側）

**コードから見えないので、ここが唯一の記録。**

| 置き場 | 値 | 無いと |
| --- | --- | --- |
| Allowed domains | Worker のホスト名（**スキーム無し**） | MCP の失敗が「Authorization が拒否された」に化ける |
| 環境変数 | `OFFDESK_URL` = `https://<worker>` | 繋がらない |
| 環境変数 | `OFFDESK_TOKEN` = Worker の secret と同じ値 | 全部 401 |
| 環境変数 | ~~`OFFDESK_ADMIN_TOKEN`~~ **置かない** | —— 置くと `/gateway/reset` がセッションから届く（§1） |
| 環境変数 | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` | 質問の直後に Claude が勝手に先へ進む |
| 環境変数 | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=3600000` | **5 分ちょうどで握りが落ちる** |
| 環境変数 | `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=10000` | **run が畳まれず 🏁 も出ない**（無音で落ちる）。§3-5 |
| 環境変数 | `CLAUDE_CODE_EFFORT_LEVEL=xhigh` | **止まらない**（モデルの既定 `high` で走るだけ）。この表で唯一「無くても壊れない」行 |

Custom のネットワークにするときは「**Also include default list of common package managers**」にチェックを入れる（外すと `raw.githubusercontent.com` が塞がり、
下の setup script が失敗する）。

### 3-1. Setup script（プラグインを入れる。**唯一の入口**）

```bash
#!/bin/bash
# 版: 4   ← プラグインを直したらこの数字を上げる（キャッシュが作り直される）
set -u
ok=0
for home in /home/user /root; do
  [ -d "$home" ] || continue
  HOME="$home" claude plugin marketplace add linto-dev-collections/offdesk || true
  HOME="$home" claude plugin install offdesk@offdesk || true

  if HOME="$home" claude plugin list 2>/dev/null | grep -q offdesk; then
    echo "OFFDESK-PLUGIN-OK: installed under ${home}"
    ok=1
  else
    echo "OFFDESK-PLUGIN-MISSING: not installed under ${home}" >&2
  fi
done
[ "$ok" = 1 ] || echo "OFFDESK-PLUGIN-FAILED: no HOME got the plugin; runs will start but stay silent on Discord" >&2
exit 0
```

- **`|| true` と `exit 0` を外さない** —— 非ゼロで終わるとセッションが起動しない
- **入ったかを最後に確かめる。** `|| true` だけだと**全部の失敗が消える** —— 起動はするのに Discord へ一言も届かないセッションができ、症状は「そもそも run が立たなかった」と見分けが付かない。環境のビルドログで **`OFFDESK-PLUGIN-FAILED`** を探せばよい形にしておく
- **`HOME` を外さない** —— root で走るので `$HOME` が session と違う
- **claude.ai のアカウント側にプラグインを入れない** —— この組織では同期が届かず、将来届くと 2 つ載る
- **入ったかを cloud session の中から見るときは `claude plugin list`**（Bash 経由）。
  **`/plugin`（スラッシュ）は cloud session では使えない** —— 端末の UI 専用

### 3-2. effort（`CLAUDE_CODE_EFFORT_LEVEL`）

**routine のフォームに effort の欄は無い**（あるのはモデルセレクタだけ）。
指定する口は cloud environment の環境変数 1 つで、値は `low` / `medium` / `high` / `xhigh` / `max` か `auto`。offdesk は **`xhigh`**（コードエージェント的な作業向け）。

- **これが最優先。** `CLAUDE_CODE_EFFORT_LEVEL` は `--effort` と `/effort` を**上書きする** —— 置いたあとに人がセッションを開いて `/effort` で下げようとしても効かない
- **`max` は環境変数でしか永続しない**（セッション内で `max` にしてもその 1 回だけ）
- **環境は全プロジェクトで共通**なので、この値も全 routine に一律で効く。
  プロジェクトごとに変えたくなったら environment を分けることになり、`OFFDESK_URL` / `OFFDESK_TOKEN` / 許可ドメイン / setup script（＋`# 版: N`）が環境の数だけ二重管理になる。**いまは 1 つで足りる**
- Opus 5 に「最初に走らせた版の effort を保留する」挙動（Fable 5 / Opus 4.8 / 4.7 にある）は**無い**ので、`/effort` が `Not applied` になる罠は踏まない

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

### 3-5. `SessionEnd` の予算はプラグインからは上げられない

`SessionEnd` の hook は**全部で 1.5 秒**を分け合う。offdesk の hook はその中で転写ログから `run_key` を拾い、Worker へ `POST /hooks/session-end` を投げる —— 間に合わないと **run が `done` に畳まれず、🏁 も出ない。**

**`hooks/hooks.json` の `timeout` ではこの予算は上がらない。** 予算を上げられるのは settings ファイル側の `timeout` だけで、**プラグインが書いた `timeout` は数に入らない**（プラグインは settings を書けないので、この経路は塞がっている）。

だから**環境変数で上げる**（§3 の表）:

```txt
CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=10000
```

この値は予算であると同時に、**自前の `timeout` を持たない hook のタイムアウトにもなる。**

**外しても静かに動き続ける。** 落ちた hook は出力ごと捨てられるので、症状は「run が `running` のまま残る」だけ —— 信号が 2 時間途絶えれば 5 分 cron が畳むので、**気づく手掛かりは「🏁 が出ないことがある」しかない。**

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

## 8. データの保持

**意図して無期限。** 消す cron も、run を消す口も置いていない。

| 表 | 何が残るか |
| --- | --- |
| `runs` | `prompt`（依頼者が `/offdesk` に書いた本文）・状態・cc セッションの URL |
| `asks` | 問いと回答の本文 |
| `events` | `report` の本文・掃除が残した 1 行 |
| `inbox` | スレッドに書かれた素の文 |
| `plans` | 行だけ（本文は R2） |
| `discord_interactions` | 処理済みの interaction id と、それが立てた run |
| R2 の `plans/` | 実装計画のファイル |

**これは「消し忘れ」ではなく方針。** 持ち主 1 人が使う道具で、run 詳細（`/runs/<run_key>`）から過去の判断を辿れることが値打ちになっている —— 期限で消すと、**古い run の「なぜそうしたか」が読めなくなる。**

### 消したくなったら

**run 単位で手で消す。** 外部キーは全部 `RESTRICT` なので、**子から順に**消す（1 つでも残っていると `runs` の DELETE が落ちる）。

```sh
# <RUN_KEY> は OFFDESK- で始まる 24 文字
wrangler d1 execute offdesk-db-prod --remote --command "
  DELETE FROM plans WHERE last_published_run_key = '<RUN_KEY>';
  DELETE FROM inbox WHERE run_key = '<RUN_KEY>' OR taken_by_run_key = '<RUN_KEY>';
  DELETE FROM events WHERE run_key = '<RUN_KEY>';
  DELETE FROM asks  WHERE run_key = '<RUN_KEY>';
  DELETE FROM discord_interactions WHERE run_key = '<RUN_KEY>';
  DELETE FROM runs  WHERE run_key = '<RUN_KEY>';
"
```

**R2 は別に消す。** 台帳の行を消しても、`plans/<plan_id>/` のオブジェクトは残る（画面の「計画を取り消す」を先に押せば両方消える）。

### `discord_interactions` だけは増え続ける

`/offdesk` とボタンを押した回数ぶん、1 行ずつ増える。**1 行は 100 バイト未満**なので放っておいてよいが、気になったら**終わった run のぶんだけ**消す（上の手順に含めてある）。**生きている run のぶんは消さない** —— 消すと、その interaction の再送が 2 本目を立てられるようになる。

---

## 9. コストを見る

**常駐 DO が 1 つであること**が唯一の効く見張り。1 つで月 約 324,000 GB-s（含有枠 400,000 の内側）で、**2 つ目を足すと超える。**
宣言が 1 つであることは `release/single-gateway.test.ts` が見張る。
実体は Cloudflare のダッシュボード（Durable Objects）で確かめる。

---

## 10. 人が測るもの

自動テストで固められない 2 つ。**測ったらこの表に書き足す。**

| 何を | どう測るか | 実測 |
| --- | --- | --- |
| `A-5` 15 分の待ちで turn が 2 回に収まる | cloud session のログで turn 数を数える | 未測定 |
| `A-8` 実装計画をスマホから開いて読める | 実機で `/p/<plan_id>/` を開く | 未測定 |

---

## 11. 困ったときに読む順

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
| 🏁 が出ない・run が `running` のまま残る | `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`（§3-5）。**`hooks.json` の `timeout` では予算は上がらない** |
| 計画の URL が 401 | `PLAN_LINK_SIGNING_KEY`（§1） |
| 計画を置けない（`plans must live under …`） | **`publish-plan.sh` は `/tmp/offdesk-plans` の下しか受けない**（要件 `F-E10`）。Claude が別の場所に書いている |
| デプロイしたのに直らない | 握りが前の版のまま（§5） |
| API が HTML を返す | `run_worker_first` の載せ忘れ（テストが落ちるはず） |
