import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newRunKey, OFFDESK_TOOL_MATCHER } from "@offdesk/domain";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const SCRIPT_PATH = "plugin/plugins/offdesk/hooks/offdesk-hook.sh";
const SCRIPT = readSource(SCRIPT_PATH);

/*
  **プラグインの `hooks/hooks.json` を読む**（2026-09-06）。以前は対象リポジトリへ
  写す `.claude/settings.json` だったが、配布物がプラグインへ移って
  **対象リポジトリには 1 バイトも置かなくなった**。形は同じ（`{ hooks: { … } }`）。
*/
const SETTINGS = JSON.parse(
  readSource("plugin/plugins/offdesk/hooks/hooks.json"),
) as {
  hooks: Record<
    string,
    readonly {
      matcher?: string;
      hooks: readonly { type: string; command: string; timeout?: number }[];
    }[]
  >;
};

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
  it("newRunKey が作る値をスクリプトの正規表現が拾う", () => {
    const runKey = newRunKey((byteLength) =>
      Uint8Array.from({ length: byteLength }, (_, i) => i * 17),
    );

    const pattern = SCRIPT.match(/'(OFFDESK-\[[^']+)'/)?.[1];
    expect(pattern).toBeDefined();
    expect(new RegExp(`^${pattern}$`).test(runKey)).toBe(true);
  });

  it("先頭の 1 件だけを採る", () => {
    expect(SCRIPT).toContain("grep -m1");
  });
});

describe("読む行を絞っている", () => {
  it("assistant の行だけを見る", () => {
    expect(SCRIPT).toContain('select(.type == "assistant")');
  });

  it("<synthetic> の行を外す", () => {
    expect(SCRIPT).toContain('.message.model != "<synthetic>"');
  });

  it("転写ログを後ろから読む", () => {
    expect(SCRIPT).toContain("tac");
    expect(SCRIPT).toContain("tail -r");
  });

  /*
    **末尾だけを反転する**（2026-09-06）。この hook は `PreToolUse` ——
    ツール呼び出しのたびに走り、転写ログは長いセッションで数 MB〜数十 MB になる。
    全体を `tac` に流すと、その CPU と I/O が**全ツール呼び出しに乗る。**
  */
  it("反転する前に tail で行数を絞っている", () => {
    expect(SCRIPT).toMatch(/tail -n "\$TAIL_LINES" "\$1" \| tac/);
    expect(SCRIPT).toMatch(/TAIL_LINES=[0-9]+/);
  });

  it("agent_id があれば何もしない", () => {
    expect(SCRIPT).toContain("agent_id");
    expect(SCRIPT).toMatch(/\[ -z "\$agent" \] \|\| exit 0/);
  });

  it("読めない行を飛ばす（fromjson?）", () => {
    expect(SCRIPT).toContain("fromjson?");
  });
});

describe("hook の名前が hooks.json と対で維持されている", () => {
  it.each(["PreToolUse", "Stop", "SessionEnd"])(
    "%s が hooks.json とスクリプトの両方にある",
    (event) => {
      expect(Object.keys(SETTINGS.hooks)).toContain(event);
      expect(SCRIPT).toContain(event);
    },
  );

  it.each(["Stop", "SessionEnd"])("%s の群は matcher を持たない", (event) => {
    for (const group of SETTINGS.hooks[event] ?? []) {
      expect(group.matcher).toBeUndefined();
    }
  });

  it("SessionEnd の timeout が curl の上限より大きい", () => {
    const timeout = SETTINGS.hooks.SessionEnd?.[0]?.hooks[0]?.timeout;

    expect(timeout).toBeDefined();
    expect(timeout ?? 0).toBeGreaterThan(10);
  });

  it("PreToolUse に承認の群と通報の群が両方ある", () => {
    const groups = SETTINGS.hooks.PreToolUse ?? [];

    /*
      **matcher は 2 通りのツール名を拾う**（`OFFDESK_TOOL_MATCHER`）。
      プラグイン経由だと `mcp__plugin_offdesk_offdesk__*` になるので
      （2026-09-05 に cloud session で実測）、片方だけにすると
      **経路を変えた瞬間に routine が静かに詰まる。**
    */
    expect(groups.map((group) => group.matcher)).toEqual([
      OFFDESK_TOOL_MATCHER,
      undefined,
    ]);
    expect(groups[0]?.hooks[0]?.command).toContain("permissionDecision");
    expect(groups[1]?.hooks[0]?.command).toContain("offdesk-hook.sh");
  });

  it("スクリプトは bash 経由で呼ぶ", () => {
    for (const groups of Object.values(SETTINGS.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (!hook.command.includes("offdesk-hook.sh")) continue;
          expect(hook.command).toMatch(/^bash /);
          /*
            **プラグインの中を指す。** `$CLAUDE_PROJECT_DIR`（対象リポジトリ）を
            指したままだと、置かなくなったファイルを探して静かに何もしない。
          */
          // biome-ignore lint/suspicious/noTemplateCurlyInString: hooks.json に書かれた文字列そのもの（評価するのではなく、あることを確かめている）。
          expect(hook.command).toContain("${CLAUDE_PLUGIN_ROOT}");
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

  it("標準出力に何も出さない", () => {
    expect(
      runHook('{"hook_event_name":"Stop","transcript_path":"/nope"}').stdout,
    ).toBe("");
  });
});

/*
  **通報の中身を実際に見る。** 上の検査はスクリプトの文字列を見ているだけで、
  「末尾を絞った結果、拾う行がずれた」を捕まえられない ——
  `curl` を差し替えて、**送る本文そのもの**を読む。
*/
describe("拾うのは直近の usage 行（末尾を絞っても変わらない）", () => {
  const usageLine = (model: string, inputTokens: number): string =>
    JSON.stringify({
      type: "assistant",
      message: {
        model,
        usage: {
          input_tokens: inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    });

  /** 転写ログと、`curl` を差し替えた PATH を作る。 */
  const stage = (
    lines: readonly string[],
  ): {
    readonly transcript: string;
    readonly pathEnv: string;
    readonly body: string;
  } => {
    const root = mkdtempSync(path.join(tmpdir(), "offdesk-hook-tail-"));
    const transcript = path.join(root, "transcript.jsonl");
    writeFileSync(transcript, `${lines.join("\n")}\n`);

    const body = path.join(root, "body.json");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "curl"),
      `#!/bin/sh\ncat > ${JSON.stringify(body)}\n`,
      { mode: 0o755 },
    );

    return { transcript, pathEnv: `${bin}:${process.env.PATH ?? ""}`, body };
  };

  const RUN_KEY = "OFFDESK-0123456789abcdef";
  const filler = (count: number): readonly string[] =>
    Array.from({ length: count }, () => JSON.stringify({ type: "user" }));

  it("古い行が何千あっても、いちばん新しい usage を送る", () => {
    const staged = stage([
      JSON.stringify({ type: "user", text: RUN_KEY }),
      usageLine("claude-opus-5", 1),
      ...filler(3_000),
      usageLine("claude-opus-5", 999),
      ...filler(10),
    ]);

    const verdict = runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        transcript_path: staged.transcript,
      }),
      { PATH: staged.pathEnv },
    );

    expect(verdict.status).toBe(0);
    expect(JSON.parse(readFileSync(staged.body, "utf8"))).toEqual({
      run_key: RUN_KEY,
      event: "PreToolUse",
      model: "claude-opus-5",
      usage: {
        input_tokens: 999,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    });
  });

  /*
    **絞った窓の外にしか usage が無ければ、その 1 回は通報しない。**
    これは意図した取引で、痛くない側に倒れている —— hook は次のツール呼び出しでも
    走るし、残量は**出ないだけ**（嘘の値は出ない。要件 `F-D4`）。
    窓（`TAIL_LINES`）は assistant の行が数行おきに来る前提より十分広い。
  */
  it("窓の外にしか usage が無ければ、黙って何も送らない", () => {
    const staged = stage([
      JSON.stringify({ type: "user", text: RUN_KEY }),
      usageLine("claude-opus-5", 42),
      ...filler(5_000),
    ]);

    const verdict = runHook(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        transcript_path: staged.transcript,
      }),
      { PATH: staged.pathEnv },
    );

    expect(verdict.status).toBe(0);
    expect(existsSync(staged.body)).toBe(false);
  });
});

describe("トークンを漏らさない（脅威 12）", () => {
  it("curl を verbose にしていない", () => {
    expect(SCRIPT).not.toMatch(/curl[^\n]*\s-v\b/);
    expect(SCRIPT).not.toContain("--verbose");
  });

  it("transcript_path を本文に載せない", () => {
    const payloads = SCRIPT.match(/jq -nc[\s\S]*?\|/g) ?? [];

    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain("transcript");
    }
  });
});

/*
  **hooks.json に書いたコマンドが、実際に bash で走ること**（2026-09-06 に踏んだ）。

  コマンドは JSON の文字列の中に埋めた**シェルの 1 行**で、`printf '…{"json"}…'` の
  形をしている —— **単一引用符の中にアポストロフィが 1 つ混ざるだけで構文エラー**に
  なる。英語に書き換えたときに `repository's` で実際に踏んだ。

  **静かに壊れる。** hook が落ちてもセッションは進むので、症状は
  「承認が出ない」「残量が出ない」だけ。JSON として妥当かを見るだけの検査では
  通ってしまう（JSON は妥当だった）—— **走らせるしかない。**
*/
describe("hooks.json のコマンドが実際に走る", () => {
  const PLUGIN_ROOT = path.join(REPO_ROOT, "plugin/plugins/offdesk");

  const run = (
    command: string,
  ): { readonly status: number; readonly stdout: string } => {
    try {
      const stdout = execFileSync("bash", ["-c", command], {
        input: "{}",
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        },
      });
      return { status: 0, stdout };
    } catch (error) {
      return { status: (error as { status?: number }).status ?? 1, stdout: "" };
    }
  };

  const commands = Object.entries(SETTINGS.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      group.hooks.map((hook) => [event, hook.command] as const),
    ),
  );

  it("コマンドが 1 つ以上ある（検査が空振りしていない）", () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it.each(commands)("%s のコマンドが 0 で終わる", (_event, command) => {
    expect(run(command).status).toBe(0);
  });

  /*
    **JSON を出すコマンドは、妥当な JSON を出す。** 出力が壊れていると
    Claude Code はその hook の指示（承認・文脈の追加）を捨てる ——
    **落ちないので、なお気付きにくい。**
  */
  it.each(
    commands.filter(([, command]) => command.includes("hookSpecificOutput")),
  )("%s のコマンドが妥当な JSON を出す", (event, command) => {
    const parsed = JSON.parse(run(command).stdout) as {
      hookSpecificOutput: { hookEventName: string };
    };

    expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
  });

  /** `${CLAUDE_PLUGIN_ROOT}` が実際に展開されること（素の文字列が残らない）。 */
  it("SessionStart の文脈にプラグインの絶対パスが入る", () => {
    const command =
      commands.find(([event]) => event === "SessionStart")?.[1] ?? "";
    const parsed = JSON.parse(run(command).stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };

    expect(parsed.hookSpecificOutput.additionalContext).toContain(PLUGIN_ROOT);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain(
      "CLAUDE_PLUGIN_ROOT",
    );
  });
});
