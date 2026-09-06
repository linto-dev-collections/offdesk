import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isPlanSlug,
  MAX_PLAN_FILE_BYTES,
  PLAN_WORK_DIR,
  PUBLISH_PLAN_SCRIPT,
  PUBLISH_PLAN_SKILL,
  PUBLISH_PLAN_SKILL_NAME,
  SERVER_INSTRUCTIONS,
} from "@offdesk/domain";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const SCRIPT_PATH = path.join("plugin/plugins/offdesk", PUBLISH_PLAN_SCRIPT);
const SCRIPT = readSource(SCRIPT_PATH);

const SKILL_PATH = path.join(
  "plugin/plugins/offdesk/skills",
  PUBLISH_PLAN_SKILL_NAME,
  "SKILL.md",
);
const SKILL = readSource(SKILL_PATH);

describe("置き場が案内と一致する", () => {
  /** **`PUBLISH_PLAN_SCRIPT` が正本。** 文言に直書きすると片方だけ直る。 */
  it("plugin に同じパスでファイルがある", () => {
    expect(existsSync(path.join(REPO_ROOT, SCRIPT_PATH))).toBe(true);
  });

  /*
    **手順を持つのは skill だけ**（2026-09-06 に移した）。以前は同じ 700 字が
    `SERVER_INSTRUCTIONS` と `ROUTINE_PROMPT` の両方に常駐していて、実際に要るのは
    長い文書を渡すときだけだった。**プロンプト側は skill を名指しするだけにする。**
  */
  it("skill がそのパスを案内する", () => {
    expect(SKILL).toContain(PUBLISH_PLAN_SCRIPT);
  });

  it("SERVER_INSTRUCTIONS が skill を名指しする", () => {
    expect(SERVER_INSTRUCTIONS).toContain(PUBLISH_PLAN_SKILL);
  });

  /** **呼ぶ名前は frontmatter の `name` で決まる**（ディレクトリ名は当てにしない）。 */
  it("skill の frontmatter が同じ名前を名乗る", () => {
    expect(SKILL).toMatch(
      new RegExp(`^name: ${PUBLISH_PLAN_SKILL_NAME}$`, "m"),
    );
  });

  /*
    **本文をツールの引数に載せないことを、両方の文言が言っていること**
    （要件 `F-E3`）。ここが抜けると Claude が 200KB を再出力する。
  */
  it("SERVER_INSTRUCTIONS が「引数に載せない」と言っている", () => {
    expect(SERVER_INSTRUCTIONS).toContain("引数に載せないで");
  });

  it("skill も「引数に載せない」と言っている", () => {
    expect(SKILL).toContain("Never put the body in a tool argument");
  });
});

describe("skill が routine で呼べる形になっている", () => {
  /*
    **routine では誰も `/` を打てない。** 依頼者は Discord にいてセッションの中には
    いないので、モデルからの発火を止めると**誰にも呼べない skill**になる ——
    症状は「長い計画が `ask_human` に貼られて 1 通に入らない」で、skill 側にエラーは出ない。
  */
  it("モデルからの発火を止めていない", () => {
    expect(SKILL).not.toContain("disable-model-invocation");
  });

  /*
    **サブエージェントの中では context 使用量が台帳に載らない** ——
    `offdesk-hook.sh` が `agent_id` のある payload を捨てる（あちらの `[ -z "$agent" ]`）。
    `context: fork` を書くと、計画を組み立てている間の消費がダッシュボードから消える。
  */
  it("subagent で走らせない", () => {
    expect(SKILL).not.toContain("context: fork");
  });
});

describe("スクリプトと Worker の口が一致する", () => {
  it("run を載せるヘッダ名が同じ", () => {
    const worker = readSource("apps/app/src/worker/plans/routes.ts");
    const header = /RUN_HEADER = "([a-z-]+)"/.exec(worker)?.[1];

    expect(header).toBeDefined();
    expect(SCRIPT).toContain(`${header}: `);
  });

  it.each([
    ["置く", 'plans.put("/:slug/:path{.+}"', "$base/plans/$slug/$rel"],
    ["仕上げる", 'plans.post("/:slug/finish"', "$base/plans/$slug/finish"],
  ])("%s path が同じ", (_label, route, url) => {
    expect(readSource("apps/app/src/worker/index.ts")).toContain(route);
    expect(SCRIPT).toContain(url);
  });

  it("Bearer を付けている", () => {
    // 正規表現で書く（素の文字列だと biome が `${…}` を書き損じと見る）。
    expect(SCRIPT).toMatch(/authorization: Bearer \$\{OFFDESK_TOKEN\}/);
  });

  /** `finish` の応答は `{ url }`。スクリプトがそこから 1 行だけ取り出す。 */
  it("応答の url を読んでいる", () => {
    expect(readSource("apps/app/src/worker/plans/routes.ts")).toContain(
      "Response.json({",
    );
    expect(SCRIPT).toContain("jq -r '.url // empty'");
  });

  it("1 ファイルの上限がコードと同じ", () => {
    const limit = /max_file_bytes=([0-9]+)/.exec(SCRIPT)?.[1];

    expect(Number(limit)).toBe(MAX_PLAN_FILE_BYTES);
  });

  /** `/plans/*` と `/p/*` が SPA フォールバックに吸われないこと。 */
  it.each(["/plans/*", "/p/*"])(
    "%s が run_worker_first に入っている",
    (route) => {
      for (const file of [
        "packages/infra/alchemy.run.ts",
        "apps/app/wrangler.jsonc",
      ]) {
        expect(readSource(file)).toContain(`"${route}"`);
      }
    },
  );
});

describe("`$var` の直後に全角文字を置かない", () => {
  /*
    **2026-09-04 に実際に踏んだ。** bash 5.3（darwin）は `"（$status）"` の
    `$status）` を**変数名ごと 1 つ**として読み、`set -u` の下で

      publish-plan.sh: line 59: status?: unbound variable

    で落ちる。**失敗経路にしか無かったので、成功する限り気付かない** ——
    実物では「置けませんでした（400）」の代わりにこの読めないエラーが出る。

    直し方は `${status}` と括ること。**メッセージが日本語である以上、
    どの `$var` の後ろにも全角の句読点が来うる**ので、機械に見張らせる。
  */
  it.each([
    ["publish-plan.sh", SCRIPT_PATH],
    ["offdesk-hook.sh", "plugin/plugins/offdesk/hooks/offdesk-hook.sh"],
  ])("%s に裸の $var ＋ 全角の並びが無い", (_label, relative) => {
    const bad = [
      ...readSource(relative).matchAll(
        /\$[A-Za-z_][A-Za-z0-9_]*[^\p{ASCII}]/gu,
      ),
    ].map((match) => match[0]);

    expect(bad).toEqual([]);
  });

  /** 実際に `set -u` で落ちることを確かめてある（回帰したらここが緑のままでは済まない）。 */
  it("bash が全角の直前で変数名を切らないことを実測で示す", () => {
    const withBraces = execFileSync(
      "bash",
      // テンプレート文字列にして `\${s}` を書く（素の文字列だと biome が書き損じと見る）。
      ["-c", `set -u; s=400; printf "%s" "だめ（\${s}）"`],
      { encoding: "utf8" },
    );

    expect(withBraces).toBe("だめ（400）");
  });
});

describe(".gitignore が同名のディレクトリを巻き込まない", () => {
  const rules = (): readonly string[] =>
    readSource(".gitignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

  it.each(["plans", "docs"])("%s はアンカー付きで書く", (name) => {
    expect(rules()).not.toContain(name);
    expect(rules()).not.toContain(`${name}/`);
    expect(rules()).toContain(`/${name}/`);
  });

  it("src の下のディレクトリ名がアンカー無しの規則と衝突しない", () => {
    const unanchored = rules()
      .filter((rule) => !rule.startsWith("/") && !rule.includes("*"))
      .map((rule) => rule.replace(/\/$/, ""));

    const names = readdirSync(path.join(REPO_ROOT, "apps/app/src"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(names).toContain("plans");
    for (const rule of unanchored) {
      expect(names).not.toContain(rule);
    }
  });
});

describe("hook とは違って、失敗したら落とす", () => {
  it("set -e が付いている", () => {
    expect(SCRIPT).toContain("set -euo pipefail");
  });

  it("exit 0 で終わっていない", () => {
    expect(SCRIPT.trimEnd().endsWith("exit 0")).toBe(false);
  });

  const runScript = (
    args: readonly string[],
    envOverrides: Readonly<Record<string, string>> = {},
  ): number => {
    try {
      execFileSync("bash", [path.join(REPO_ROOT, SCRIPT_PATH), ...args], {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          OFFDESK_URL: "https://offdesk.invalid",
          OFFDESK_TOKEN: "test-token",
          ...envOverrides,
        },
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };

  it.each([
    ["引数が無い", [] as readonly string[], {}],
    ["対象が無い", ["OFFDESK-1111111111111111"], {}],
    [
      "見つからないディレクトリ",
      ["OFFDESK-1111111111111111", "/nope/nothing"],
      {},
    ],
    [
      "OFFDESK_URL が未設定",
      ["OFFDESK-1111111111111111", "/nope"],
      { OFFDESK_URL: "" },
    ],
    [
      "OFFDESK_TOKEN が未設定",
      ["OFFDESK-1111111111111111", "/nope"],
      { OFFDESK_TOKEN: "" },
    ],
  ])("%s なら非ゼロで終わる", (_label, args, envOverrides) => {
    expect(runScript(args, envOverrides)).not.toBe(0);
  });
});

describe("置けるのは作業領域の下だけ（プロンプトインジェクションの出口を塞ぐ）", () => {
  /*
    **プロンプトが「そこに書け」と言うだけでは足りない**（2026-09-06 に足した）。

    このスクリプトはセッションの中で bash から呼べて、上げたものは
    **ログイン無しで 7 日間読める署名付き URL**（要件 `F-E5`）になる。
    引数が自由だと、リポジトリ・PR・fetch した Web から入った 1 行で
    読めるファイルが何でも外へ出る口になる。**引数の側で閉じる。**
  */
  const workspace = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), "offdesk-plan-guard-"));
    mkdirSync(path.join(root, "wd", "myplan"), { recursive: true });
    writeFileSync(path.join(root, "wd", "myplan", "a.md"), "hi\n");
    mkdirSync(path.join(root, "outside"), { recursive: true });
    writeFileSync(path.join(root, "outside", "secret.txt"), "s\n");
    symlinkSync(path.join(root, "outside"), path.join(root, "wd", "escape"));
    return root;
  };

  const run = (
    target: string,
    workDir: string,
  ): { readonly status: number; readonly stderr: string } => {
    try {
      execFileSync(
        "bash",
        [path.join(REPO_ROOT, SCRIPT_PATH), "OFFDESK-1111111111111111", target],
        {
          encoding: "utf8",
          stdio: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            OFFDESK_URL: "https://offdesk.invalid",
            OFFDESK_TOKEN: "test-token",
            PLAN_WORK_DIR: workDir,
          },
        },
      );
      return { status: 0, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { status: failure.status ?? 1, stderr: failure.stderr ?? "" };
    }
  };

  it.each([
    ["作業領域の外", "outside"],
    ["作業領域の中から外を指す symlink", "wd/escape"],
  ])("%s は置かせない", (_label, relative) => {
    const root = workspace();
    const verdict = run(path.join(root, relative), path.join(root, "wd"));

    expect(verdict.status).not.toBe(0);
    expect(verdict.stderr).toContain("plans must live under");
  });

  it("作業領域そのものが無ければ落ちる（黙って全部を通さない）", () => {
    const root = workspace();
    const verdict = run(path.join(root, "wd", "myplan"), path.join(root, "no"));

    expect(verdict.status).not.toBe(0);
    expect(verdict.stderr).toContain("work directory does not exist");
  });

  /*
    **通る側も固める。** 検査だけ足して置けなくなっては意味がない。
    宛先は解決できないので curl が落ちる（＝ 検査は抜けている）。
  */
  it.each([
    ["ディレクトリ", "wd/myplan"],
    ["1 ファイル", "wd/myplan/a.md"],
  ])("作業領域の中の %s は検査を抜ける", (_label, relative) => {
    const root = workspace();
    const verdict = run(path.join(root, relative), path.join(root, "wd"));

    expect(verdict.stderr).not.toContain("plans must live under");
    expect(verdict.stderr).toContain("offdesk.invalid");
  });

  /** **既定値が `PLAN_WORK_DIR` と同じ**（プロンプトが案内する場所と対）。 */
  it("スクリプトの既定が PLAN_WORK_DIR と一致する", () => {
    expect(SCRIPT).toContain(`\${PLAN_WORK_DIR:-${PLAN_WORK_DIR}}`);
  });
});

describe("スクリプトが作る名前が台帳を通る", () => {
  /**
   * スクリプトの `slug` の式をそのまま回す。**ここが `plans_slug_shape_ck` に
   * 落ちる形を作ると、置く前に 400 になる。**
   */
  const slugOf = (name: string): string => {
    const out = execFileSync(
      "bash",
      [
        "-c",
        `printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g; s/^[^a-z0-9]*//; s/-*$//' | cut -c1-64`,
        "bash",
        name,
      ],
      { encoding: "utf8" },
    );

    /*
      **末尾の改行を落とす**（スクリプト側は `$(…)` が同じことをしている）。
      `cut` は行を切ったときだけ改行を足すので（実測: 200 文字を `cut -c1-64`
      すると 65 バイト）、ここで落とさないと**長い名前の場合だけ**比較がずれる。
    */
    return out.replace(/\n+$/, "");
  };

  it.each([
    ["github-link", "github-link"],
    ["GitHub Link", "github-link"],
    ["phase-06-plans", "phase-06-plans"],
    ["01-first", "01-first"],
    ["-lead", "lead"],
    ["a_b", "a_b"],
  ])("%s → %s", (name, expected) => {
    const slug = slugOf(name);

    expect(slug).toBe(expected);
    expect(isPlanSlug(slug)).toBe(true);
  });

  it("長い名前は 64 文字に切る", () => {
    const slug = slugOf("a".repeat(200));

    expect(slug).toHaveLength(64);
    expect(isPlanSlug(slug)).toBe(true);
  });

  it("日本語だけの名前は空になる（スクリプトが die する）", () => {
    expect(slugOf("実装計画")).toBe("");
    expect(isPlanSlug("")).toBe(false);
  });
});

describe("トークンを漏らさない（脅威 12）", () => {
  it("curl を verbose にしていない", () => {
    expect(SCRIPT).not.toMatch(/curl[^\n]*\s-v\b/);
    expect(SCRIPT).not.toContain("--verbose");
  });

  /** 応答本文は一時ファイルへ。標準出力に出るのは URL の 1 行だけ。 */
  it("標準出力に出すのは url だけ", () => {
    const prints = [...SCRIPT.matchAll(/^printf .*$/gm)].map(
      (match) => match[0],
    );

    expect(prints).toContain("printf '%s\\n' \"$url\"");
    for (const line of prints) {
      expect(line).not.toContain("OFFDESK_TOKEN");
    }
  });
});
