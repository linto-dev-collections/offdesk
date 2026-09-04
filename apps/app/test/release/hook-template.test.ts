import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newRunKey } from "@offdesk/domain";
import { describe, expect, it } from "vitest";

/*
  **`repo-template/.claude/` は「コードの外にある前提」の 1 つ**（要件 §9-1・計画 P5）。

  対象リポジトリに commit されるファイルなので、ここを直しても勝手には追従しない。
  それでも**4 つはコードと対で維持されている**:

    1. `run_key` の形（`domain/ids.ts` が作る値を、スクリプトの正規表現が拾えるか）
    2. hook の名前（`settings.json` の鍵と、スクリプトの `case` の分岐）
    3. 送り先の path（`/hooks/context` と `/hooks/session-end`）
    4. **`exit 0` の規律**（非ゼロで終わると Claude の動作に影響する）

  **どれが壊れても症状は「残量が出ない」で同じ**なので、機械に見張らせる。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const SCRIPT_PATH = "repo-template/.claude/hooks/offdesk-hook.sh";
const SCRIPT = readSource(SCRIPT_PATH);

const SETTINGS = JSON.parse(
  readSource("repo-template/.claude/settings.json"),
) as {
  hooks: Record<
    string,
    readonly {
      matcher?: string;
      hooks: readonly { type: string; command: string; timeout?: number }[];
    }[]
  >;
};

/** スクリプトを走らせる口。**標準入力が hook の JSON。** */
const runHook = (
  stdin: string,
  envOverrides: Readonly<Record<string, string>> = {},
): { readonly status: number; readonly stdout: string } => {
  try {
    const stdout = execFileSync("bash", [path.join(REPO_ROOT, SCRIPT_PATH)], {
      input: stdin,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        OFFDESK_URL: "https://offdesk.invalid",
        OFFDESK_TOKEN: "test-token",
        ...envOverrides,
      },
    });
    return { status: 0, stdout };
  } catch (error) {
    const status = (error as { status?: number }).status ?? 1;
    return { status, stdout: "" };
  }
};

describe("run_key の形がコードと対で維持されている", () => {
  /*
    **スクリプトは転写ログから `OFFDESK-<16hex>` を拾う。** `newRunKey` の
    形（接頭辞・バイト数）を変えると、hook は run_key を見つけられず
    **黙って何もしなくなる**（症状は「残量が出ない」）。
  */
  it("newRunKey が作る値をスクリプトの正規表現が拾う", () => {
    const runKey = newRunKey((byteLength) =>
      Uint8Array.from({ length: byteLength }, (_, i) => i * 17),
    );

    const pattern = SCRIPT.match(/'(OFFDESK-\[[^']+)'/)?.[1];
    expect(pattern).toBeDefined();
    expect(new RegExp(`^${pattern}$`).test(runKey)).toBe(true);
  });

  /*
    **最初の 1 件を採ることが要件。** 最後を採ると、Claude が本文に書いた
    別の値を拾う —— P3a §10-5 の切り分けは存在しない
    `OFFDESK-0000000000000000` を喋らせるので、実際に当たる。
  */
  it("先頭の 1 件だけを採る", () => {
    expect(SCRIPT).toContain("grep -m1");
  });
});

describe("hook の名前が settings.json と対で維持されている", () => {
  it.each(["PreToolUse", "Stop", "SessionEnd"])(
    "%s が settings.json とスクリプトの両方にある",
    (event) => {
      expect(Object.keys(SETTINGS.hooks)).toContain(event);
      expect(SCRIPT).toContain(event);
    },
  );

  /*
    **`matcher` を書かない**（計画 P5 §3-6 から変えたところ）。
    `SessionEnd` の matcher は**終了理由**に当たるので、`""` を書くと
    完全一致の経路で**どの理由にも当たらず 1 度も鳴らない。**
    省略すれば「毎回鳴る」になる（`Stop` は matcher 非対応で無視される）。
  */
  it.each(["Stop", "SessionEnd"])("%s の群は matcher を持たない", (event) => {
    for (const group of SETTINGS.hooks[event] ?? []) {
      expect(group.matcher).toBeUndefined();
    }
  });

  /*
    **`SessionEnd` には明示のタイムアウトが要る。** 既定は**1.5 秒**の共有予算で、
    スクリプトの `curl -m 10` が終わる前に打ち切られる
    （per-hook の `timeout` を書くと予算がそこまで上がる）。
  */
  it("SessionEnd の timeout が curl の上限より大きい", () => {
    const timeout = SETTINGS.hooks.SessionEnd?.[0]?.hooks[0]?.timeout;

    expect(timeout).toBeDefined();
    expect(timeout ?? 0).toBeGreaterThan(10);
  });

  /*
    **P4 の事前承認の群を消していない。** `PreToolUse` には 2 つの群がある ——
    offdesk のツールを allow する群（P4）と、残量を通報する群（P5）。
    片方を消すと「承認待ちで固まる」か「残量が出ない」になる。
  */
  it("PreToolUse に承認の群と通報の群が両方ある", () => {
    const groups = SETTINGS.hooks.PreToolUse ?? [];

    expect(groups.map((group) => group.matcher)).toEqual([
      "mcp__offdesk__.*",
      undefined,
    ]);
    expect(groups[0]?.hooks[0]?.command).toContain("permissionDecision");
    expect(groups[1]?.hooks[0]?.command).toContain("offdesk-hook.sh");
  });

  /*
    **`bash` で起動する。** スクリプトを直に指定すると、実行ビットと
    `$CLAUDE_PROJECT_DIR` の解決という失敗点が増え、**どちらを外しても
    症状は「残量が出ない」で同じ**になる（P4 の allow フックと同じ判断）。
  */
  it("スクリプトは bash 経由で呼ぶ", () => {
    for (const groups of Object.values(SETTINGS.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (!hook.command.includes("offdesk-hook.sh")) continue;
          expect(hook.command).toMatch(/^bash /);
        }
      }
    }
  });
});

describe("送り先が Worker の口と対で維持されている", () => {
  it.each([
    ["context", "hooks/context"],
    ["session-end", "hooks/session-end"],
  ])("%s の path がスクリプトにある", (_label, fragment) => {
    expect(SCRIPT).toContain(fragment.replace("hooks/", ""));
  });

  it("Worker が同じ path を持っている", () => {
    const source = readSource("apps/app/src/worker/index.ts");

    expect(source).toContain('hooks.post("/context"');
    expect(source).toContain('hooks.post("/session-end"');
  });

  it("/hooks/* が run_worker_first に入っている", () => {
    for (const file of [
      "packages/infra/alchemy.run.ts",
      "apps/app/wrangler.jsonc",
    ]) {
      expect(readSource(file)).toContain('"/hooks/*"');
    }
  });
});

describe("必ず exit 0 する", () => {
  /*
    **hook が非ゼロで終わると Claude の動作に影響する**（計画 P5 §3-2）。
    通報は best-effort なので、**止めてよい理由が 1 つも無い。**
    ここは実際に走らせて確かめる —— `set -u` を足したときに
    「環境変数が無いと非ゼロ」が静かに戻ってくる箇所。
  */
  it.each([
    ["空入力", "", {}],
    ["JSON ではない", "not json", {}],
    ["event が無い", "{}", {}],
    [
      "転写ログが無い",
      '{"hook_event_name":"Stop","transcript_path":"/nope"}',
      {},
    ],
    [
      "知らない event",
      '{"hook_event_name":"PostToolUse","transcript_path":"/nope"}',
      {},
    ],
    [
      "OFFDESK_URL が未設定",
      '{"hook_event_name":"Stop","transcript_path":"/nope"}',
      { OFFDESK_URL: "" },
    ],
    [
      "OFFDESK_TOKEN が未設定",
      '{"hook_event_name":"Stop","transcript_path":"/nope"}',
      { OFFDESK_TOKEN: "" },
    ],
  ])("%s でも 0 で終わる", (_label, stdin, envOverrides) => {
    expect(runHook(stdin, envOverrides).status).toBe(0);
  });

  /** 届かない宛先でも 0（`|| true` が握っている）。 */
  it("Worker へ届かなくても 0 で終わる", () => {
    const transcript = path.join(REPO_ROOT, "package.json");

    expect(
      runHook(
        JSON.stringify({
          hook_event_name: "SessionEnd",
          transcript_path: transcript,
        }),
      ).status,
    ).toBe(0);
  });

  /** **標準出力に何も出さない。** 出すと hook の応答として読まれる。 */
  it("標準出力に何も出さない", () => {
    expect(
      runHook('{"hook_event_name":"Stop","transcript_path":"/nope"}').stdout,
    ).toBe("");
  });
});

describe("トークンを漏らさない（脅威 12）", () => {
  /** `-v` を付けると要求ヘッダが標準エラーに出る。 */
  it("curl を verbose にしていない", () => {
    expect(SCRIPT).not.toMatch(/curl[^\n]*\s-v\b/);
    expect(SCRIPT).not.toContain("--verbose");
  });

  /** 転写ログのパスを送らない（offdesk 側で使い道が無い）。 */
  it("transcript_path を本文に載せない", () => {
    const payloads = SCRIPT.match(/jq -nc[\s\S]*?\|/g) ?? [];

    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain("transcript");
    }
  });
});
