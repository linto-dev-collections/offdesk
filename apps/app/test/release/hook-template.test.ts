import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newRunKey } from "@offdesk/domain";
import { describe, expect, it } from "vitest";

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

  it("agent_id があれば何もしない", () => {
    expect(SCRIPT).toContain("agent_id");
    expect(SCRIPT).toMatch(/\[ -z "\$agent" \] \|\| exit 0/);
  });

  it("読めない行を飛ばす（fromjson?）", () => {
    expect(SCRIPT).toContain("fromjson?");
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

    expect(groups.map((group) => group.matcher)).toEqual([
      "mcp__offdesk__.*",
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
