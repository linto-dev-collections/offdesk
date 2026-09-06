import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OFFDESK_TOOL_MATCHER } from "@offdesk/domain";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const TEMPLATE = JSON.parse(readSource("plugin/plugins/offdesk/.mcp.json")) as {
  mcpServers: Record<
    string,
    {
      type: string;
      url: string;
      headers: Record<string, string>;
      timeout: number;
      alwaysLoad: boolean;
    }
  >;
};

const SERVER_NAME = "offdesk";

const TOOL_NAMES = ["ask_human", "ask_wait", "report"] as const;

const SETTINGS = JSON.parse(
  readSource("plugin/plugins/offdesk/hooks/hooks.json"),
) as {
  hooks: {
    PreToolUse: readonly {
      matcher?: string;
      hooks: readonly { type: string; command: string }[];
    }[];
  };
};

const envPlaceholder = (name: string): string => `\${${name}}`;

describe("plugin の .mcp.json", () => {
  it("サーバー名が offdesk（ツール名が mcp__offdesk__* になる）", () => {
    expect(Object.keys(TEMPLATE.mcpServers)).toEqual([SERVER_NAME]);
  });

  it("Worker の /mcp を指す", () => {
    const server = TEMPLATE.mcpServers[SERVER_NAME];

    expect(server?.type).toBe("http");
    expect(server?.url).toBe(`${envPlaceholder("OFFDESK_URL")}/mcp`);
  });

  it("Bearer を OFFDESK_TOKEN から渡す", () => {
    expect(TEMPLATE.mcpServers[SERVER_NAME]?.headers.Authorization).toBe(
      `Bearer ${envPlaceholder("OFFDESK_TOKEN")}`,
    );
  });

  it("timeout が 1 時間で、握りの上限より大きい", async () => {
    const { ASK_HOLD_MS } = await import("@offdesk/domain");

    expect(TEMPLATE.mcpServers[SERVER_NAME]?.timeout).toBe(3_600_000);
    expect(TEMPLATE.mcpServers[SERVER_NAME]?.timeout).toBeGreaterThan(
      ASK_HOLD_MS,
    );
  });

  it("alwaysLoad が true（tool search でツールが消えない）", () => {
    expect(TEMPLATE.mcpServers[SERVER_NAME]?.alwaysLoad).toBe(true);
  });
});

describe("サーバー名が 3 か所で揃っている", () => {
  it("MCP サーバーの serverInfo が同じ名前を名乗る", () => {
    const source = readSource("apps/app/src/worker/mcp/server.ts");

    expect(source).toContain(`name: "${SERVER_NAME}"`);
  });

  it("ROUTINE_PROMPT が素の名前で 3 つのツールを案内する", async () => {
    const { OFFDESK_TOOLS, ROUTINE_PROMPT } = await import("@offdesk/domain");

    for (const tool of OFFDESK_TOOLS) {
      expect(ROUTINE_PROMPT).toContain(`\`${tool}\``);
    }
  });

  it("ROUTINE_PROMPT が接頭辞を固定していない", async () => {
    const { ROUTINE_PROMPT } = await import("@offdesk/domain");

    expect(ROUTINE_PROMPT).toContain("mcp__plugin_offdesk_offdesk__ask_human");
    expect(ROUTINE_PROMPT).toContain("一覧に出ている名前");
  });

  it("OFFDESK_TOOLS が実装のツール名と一致する", async () => {
    const { OFFDESK_TOOLS } = await import("@offdesk/domain");
    const source = readSource("apps/app/src/worker/mcp/server.ts");

    expect([...OFFDESK_TOOLS]).toEqual([...TOOL_NAMES]);
    for (const tool of OFFDESK_TOOLS) {
      expect(source).toContain(`name: "${tool}"`);
    }
  });
});

describe("/mcp が run_worker_first に入っている", () => {
  it.each([
    ["packages/infra/alchemy.run.ts", "本番"],
    ["apps/app/wrangler.jsonc", "ローカル"],
  ])("%s（%s）に /mcp がある", (file) => {
    expect(readSource(file)).toContain('"/mcp"');
  });
});

describe("plugin の hooks.json", () => {
  it("権限の宣言を持たない（承認は hook が出す）", () => {
    expect(SETTINGS).not.toHaveProperty("permissions");
  });

  it.each(TOOL_NAMES)("%s が実物のツール名", (tool) => {
    expect(readSource("apps/app/src/worker/mcp/server.ts")).toContain(
      `name: "${tool}"`,
    );
  });

  it("フックの matcher が offdesk のツールだけを拾う", () => {
    const allowing = SETTINGS.hooks.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command.includes("permissionDecision")),
    );

    expect(allowing.map((entry) => entry.matcher)).toEqual([
      OFFDESK_TOOL_MATCHER,
    ]);
    expect(allowing[0]?.hooks[0]?.type).toBe("command");
  });

  it("フックが PreToolUse を allow する JSON を出す", () => {
    const command =
      SETTINGS.hooks.PreToolUse.flatMap((entry) => entry.hooks)
        .map((hook) => hook.command)
        .find((value) => value.includes("permissionDecision")) ?? "";
    const stdout = execFileSync("bash", ["-c", command], { encoding: "utf8" });

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: expect.any(String),
      },
    });
  });
});
