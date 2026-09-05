import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");
const APP_DIR = path.join(REPO_ROOT, "apps/app");
const DIST = path.join(APP_DIR, "dist");

const CANARY = "offdesk-canary-4b7e2a91-must-not-reach-the-client";

/**
 * canary を注ぐ環境変数（計画 P8 §2-2）。
 *
 * **値そのものではなく canary を入れる。** `.env.local` を読む形は CI で
 * 空振りする（あちらにファイルが無い）——**注いだ値が出てこない**ことを見れば、
 * ローカルでも CI でも同じ強さで言える（P1 §9-4-1）。
 *
 * `ALCHEMY_PASSWORD` は Worker が受け取らない値だが、**注いでも出てこない**ことを
 * 確かめる意味がある —— ルートの `.env.local` と `apps/app/.env.local` を
 * 分けている理由そのもの（脅威 4）で、混ざれば `@cloudflare/vite-plugin` が
 * `dist/<worker>/.dev.vars` へ平文で書き出す。
 */
const SECRET_ENV_NAMES = [
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_ALLOWED_EMAILS",
  "OFFDESK_TOKEN",
  "FIRE_TOKEN_KEY",
  "DISCORD_BOT_TOKEN",
  "PLAN_LINK_SIGNING_KEY",
  "ALCHEMY_PASSWORD",
] as const;

/**
 * **サーバー側のコードが混ざっていない証拠**（計画 P8 §2-2）。
 *
 * canary は「値が漏れていないか」しか見ない。こちらは**形が漏れていないか** ——
 * これらの文字列は外向きの HTTP を組む場所にしか無いので、
 * client のバンドルに現れたら **`src/worker` か `packages/db` が混ざった**合図。
 *
 * **`api.anthropic.com` を入れるために契約を 1 つ割った**（2026-09-05・P8 §9-3）。
 * `FIRE_URL_PREFIX` は投入の Zod（CLI と Worker の投入口だけが使う）に居たが、
 * 画面が使う `ProjectSummary` と同じモジュールだったのでバンドルに載っていた。
 */
const SERVER_ONLY_MARKERS = [
  "api.anthropic.com",
  "discord.com/api",
  "gateway.discord.gg",
  // fire URL の経路。**1 つで（トークンがあれば）起動できる**（脅威 3）。
  "trig_",
  // D1 を触るコード（`packages/db`）。
  "drizzle",
  // Workers ランタイムの仮想モジュール。client から到達したらビルドの分離が壊れている。
  "cloudflare:workers",
] as const;

const filesUnder = (dir: string): readonly string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
};

const namesIn = (file: string): readonly string[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const match = /^([A-Z0-9_]+)\s*=/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
};

/**
 * **この hook は本物の build を 1 回回す。** vitest の hook の既定は 10 秒で、
 * turbo のキャッシュが温かいときは 5 秒弱で済むが、**冷たいときは超える**
 * （2026-09-04 に実測: 温かい 4.7 秒 / 冷たいと 10 秒超で `Hook timed out`）。
 *
 * **CI では必ず冷たい。** `.github/workflows/ci.yml` は `pnpm test` を `pnpm build`
 * より先に回すので、ここが毎回最初の build になる —— 既定のままだと
 * 「ソースを触った回だけ落ちる」当たり外れになる。
 */
const BUILD_TIMEOUT_MS = 180_000;

beforeAll(() => {
  execFileSync("pnpm", ["-F", "app", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      ...Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, CANARY])),
    },
  });
}, BUILD_TIMEOUT_MS);

describe("クライアントバンドル", () => {
  it("走査するファイルがある", () => {
    expect(filesUnder(path.join(DIST, "client")).length).toBeGreaterThan(0);
  });

  it("秘密を build の env に入れても client に出てこない", () => {
    const leaked = filesUnder(path.join(DIST, "client"))
      .filter((file) => readFileSync(file, "utf8").includes(CANARY))
      .map((file) => path.relative(DIST, file));

    expect(leaked).toEqual([]);
  });

  /*
    **`.js` だけを見る。** sourcemap（`.js.map`）には元のモジュール名が入るが、
    あれは配られても中身は同じで、走査すると「コメントに書いたホスト名」まで
    拾って落ちる —— 見たいのは**実行されるコードに混ざっていないか。**
  */
  it.each(SERVER_ONLY_MARKERS)("client に %s が出てこない", (marker) => {
    const leaked = filesUnder(path.join(DIST, "client"))
      .filter((file) => file.endsWith(".js"))
      .filter((file) => readFileSync(file, "utf8").includes(marker))
      .map((file) => path.relative(DIST, file));

    expect(leaked).toEqual([]);
  });

  /*
    **走査そのものが空振りしていないこと。** `dist/client` に `.js` が
    1 つも無ければ上の検査は全部緑になる —— 上の「走査するファイルがある」は
    sourcemap でも満たせるので、`.js` の数を別に見る。
  */
  it("走査対象の .js がある", () => {
    const scripts = filesUnder(path.join(DIST, "client")).filter((file) =>
      file.endsWith(".js"),
    );

    expect(scripts.length).toBeGreaterThan(0);
  });
});

describe("焼き込まれる候補が存在しないこと", () => {
  it("OFFDESK_PUBLIC_ の変数が 1 つも無い", () => {
    const prefixed = [
      ...namesIn(path.join(APP_DIR, ".env.example")),
      ...namesIn(path.join(APP_DIR, ".env.local")),
    ].filter((name) => name.startsWith("OFFDESK_PUBLIC_"));

    expect(prefixed).toEqual([]);
  });

  it("apps/app/.env.example に ALCHEMY_ の変数が無い", () => {
    const alchemy = namesIn(path.join(APP_DIR, ".env.example")).filter((name) =>
      name.startsWith("ALCHEMY_"),
    );

    expect(alchemy).toEqual([]);
  });
});
