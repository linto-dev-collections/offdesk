import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/*
  `.env.local` の値が 1 つもクライアントバンドルに入らないこと（plans/security.md 脅威 4）。

  検査の対象を「決め打ちの秘密の名前」ではなく**手元の `.env.local` の値そのもの**にしてあるのが要点。
  名前で探す形だと、Better Auth が `Object.freeze({ get BETTER_AUTH_SECRET() {...} })` のような env アクセサをバンドルに含むだけで落ちる（値は入っていないので偽の警告になる）。
  逆に、名前を 1 つ書き忘れると本物の漏洩を見逃す。値で探せば、どちらも起きない。

  自分でビルドするのは、静的解析の連鎖が `test` を `build` より先に回すため（`dist/` が古いまま検査すると意味が無い）。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");
const APP_DIR = path.join(REPO_ROOT, "apps/app");
const DIST = path.join(APP_DIR, "dist");

type EnvEntry = Readonly<{ name: string; value: string }>;

const parseEnv = (file: string): readonly EnvEntry[] => {
  if (!existsSync(file)) return [];

  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match?.[1] === undefined) return [];
      return [
        {
          name: match[1],
          value: (match[2] ?? "").replace(/^["']|["']$/g, "").trim(),
        },
      ];
    });
};

/**
 * **`.env.example` に書いてある値は秘密ではない。**
 *
 * あのファイルは commit されているので、そこに載っている値（`BETTER_AUTH_URL` の `http://localhost:5173` や `AUTH_ALLOWED_EMAILS` の既定）は公開値。
 * 写したままの `.env.local` で検査が落ちるのを防ぐのがここの役目——
 * 例の値は短くて一般的な文字列になりがちで、minify したバンドルに偶然含まれうる。
 */
const exampleValues = (dir: string): ReadonlySet<string> =>
  new Set(
    parseEnv(path.join(dir, ".env.example"))
      .map((entry) => entry.value)
      .filter((value) => value.length > 0),
  );

/** 漏れていたら困る値。**名前を持ったまま返す**（落ちたときに何が漏れたか分かるように）。 */
const secretsIn = (dir: string): readonly EnvEntry[] => {
  const examples = exampleValues(dir);

  return parseEnv(path.join(dir, ".env.local")).filter((entry) => {
    // 短すぎる値は誤検知になる（`true` や `1` は JS のどこかに必ず出る）。
    if (entry.value.length < 12) return false;
    // URL は公開値。バンドルに入っていてよい。
    if (entry.value.startsWith("http://") || entry.value.startsWith("https://"))
      return false;
    return !examples.has(entry.value);
  });
};

const filesUnder = (dir: string): readonly string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
};

/**
 * `dir` 以下で `secrets` のどれかを含むファイル。
 *
 * 報告するのは変数名とファイル名だけで、値は出さない（P0 の `assertEnv` と同じ約束。plans/security.md 脅威 12）。
 * 長さだけを出す形にしていたら、落ちたときにどの変数か分からず切り分けられなかった（実際にそうなった。§9-4）。
 */
const leakedIn = (
  dir: string,
  secrets: readonly EnvEntry[],
): readonly string[] =>
  filesUnder(dir).flatMap((file) => {
    const content = readFileSync(file, "utf8");
    return secrets
      .filter((entry) => content.includes(entry.value))
      .map(
        (entry) => `${entry.name} が ${path.relative(DIST, file)} に含まれる`,
      );
  });

beforeAll(() => {
  execFileSync("pnpm", ["-F", "app", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
});

/*
  この検査が空振りしていないことを、検査自身に宣言させる。

  `secretsIn` が（正規表現の書き間違いや `.env.local` が空であることで）空配列を返すと、下の検査は「何も探さずに緑」になる。
  P0・P1 でそれを 3 回踏んだので（§9-4）、前提を明示する。
*/
describe("検査の前提", () => {
  it("ルートの .env.local から値を取り出せている", () => {
    const secrets = secretsIn(REPO_ROOT);

    expect(secrets.map((entry) => entry.name)).toContain("ALCHEMY_PASSWORD");
    // 取り出した値が本当にそのファイルの中身なら、突き合わせは働いている。
    expect(readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8")).toContain(
      secrets[0]?.value ?? "",
    );
  });

  it("apps/app/.env.local から値を取り出せている", () => {
    const names = secretsIn(APP_DIR).map((entry) => entry.name);

    // P1 の 2 つは秘密。`BETTER_AUTH_URL` は URL、`AUTH_ALLOWED_EMAILS` は
    // `.env.example` の既定と同じなら除かれる（どちらも公開値）。
    expect(names).toContain("BETTER_AUTH_SECRET");
    expect(names).toContain("GOOGLE_CLIENT_SECRET");
  });
});

describe("クライアントバンドル", () => {
  it("ビルド成果物がある", () => {
    expect(filesUnder(path.join(DIST, "client")).length).toBeGreaterThan(0);
  });

  it("apps/app/.env.local の値が 1 つも含まれない", () => {
    expect(leakedIn(path.join(DIST, "client"), secretsIn(APP_DIR))).toEqual([]);
  });

  /*
    環境変数を読む経路そのものが残っていないこと。

    `envPrefix: "OFFDESK_PUBLIC_"` にしてあるので Vite はどの環境変数も埋め込まず、`process.env` は空オブジェクトに置き換わる。
    値の突き合わせよりこちらの方が強い——値が偶然一致しないだけの状態と、経路が無い状態を区別できる。
    既定の `VITE_` に戻すと、その接頭辞の値が全部バンドルに載る。
  */
  it("process.env が残っていない", () => {
    for (const file of filesUnder(path.join(DIST, "client"))) {
      if (!file.endsWith(".js")) continue;
      expect(readFileSync(file, "utf8")).not.toContain("process.env");
    }
  });

  it("import.meta.env が残っていない", () => {
    for (const file of filesUnder(path.join(DIST, "client"))) {
      if (!file.endsWith(".js")) continue;
      expect(readFileSync(file, "utf8")).not.toContain("import.meta.env");
    }
  });

  /*
    **`envPrefix` がどの変数にも当たらないこと。**

    上の 2 つは「今のコードが env を読んでいない」ことを見るが、これは「読もうとしても渡るものが無い」ことを見る。`.env.example` に `OFFDESK_PUBLIC_` の変数が 1 つでも増えたら、その値はバンドルに載る。
  */
  it("OFFDESK_PUBLIC_ の変数が 1 つも無い", () => {
    const prefixed = [
      ...parseEnv(path.join(APP_DIR, ".env.example")),
      ...parseEnv(path.join(APP_DIR, ".env.local")),
    ].filter((entry) => entry.name.startsWith("OFFDESK_PUBLIC_"));

    expect(prefixed.map((entry) => entry.name)).toEqual([]);
  });
});

describe("Alchemy 専用の秘密", () => {
  /*
    **ルートの `.env.local` の値は `dist/` のどこにも出ない**（P0 §9-2 の決定）。

    `@cloudflare/vite-plugin` は `apps/app/.env.local` の中身を `dist/<worker>/.dev.vars` へ平文で書き出す。
    P1 以降は Worker が本当に秘密を必要とするので、あのファイルが出ること自体は正常（`dist/` は .gitignore に入り、wrangler もアップロードしない）。

    だからこそ「Worker が 1 度も要らない値」を分けてある。
    `ALCHEMY_PASSWORD` は Alchemy の状態を復号する鍵で、これが漏れると全ステージのシークレットが読める。
    ルート側に置いたことがビルド成果物で保たれているかを、ここで見る。
  */
  it("dist 全体に 1 つも含まれない", () => {
    expect(leakedIn(DIST, secretsIn(REPO_ROOT))).toEqual([]);
  });
});
