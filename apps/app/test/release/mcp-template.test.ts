import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const TEMPLATE = JSON.parse(readSource("repo-template/.mcp.json")) as {
  mcpServers: Record<
    string,
    {
      type: string;
      url: string;
      headers: Record<string, string>;
      timeout: number;
    }
  >;
};

const SERVER_NAME = "offdesk";

const TOOL_NAMES = ["ask_human", "ask_wait", "report"] as const;

const SETTINGS = JSON.parse(
  readSource("repo-template/.claude/settings.json"),
) as {
  permissions: { allow: readonly string[] };
  hooks: {
    PreToolUse: readonly {
      matcher: string;
      hooks: readonly { type: string; command: string }[];
    }[];
  };
};

const envPlaceholder = (name: string): string => `\${${name}}`;

describe("repo-template/.mcp.json", () => {
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
});

describe("サーバー名が 3 か所で揃っている", () => {
  it("MCP サーバーの serverInfo が同じ名前を名乗る", () => {
    const source = readSource("apps/app/src/worker/mcp/server.ts");

    expect(source).toContain(`name: "${SERVER_NAME}"`);
  });

  it("ROUTINE_PROMPT が mcp__offdesk__ask_human を名指しする", async () => {
    const { ROUTINE_PROMPT } = await import("@offdesk/domain");

    expect(ROUTINE_PROMPT).toContain(`mcp__${SERVER_NAME}__ask_human`);
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

describe("repo-template/.claude/settings.json", () => {
  it("3 つのツールを allow に名指しする", () => {
    expect(SETTINGS.permissions.allow).toEqual(
      TOOL_NAMES.map((tool) => `mcp__${SERVER_NAME}__${tool}`),
    );
  });

  it.each(TOOL_NAMES)("allow の %s が実物のツール名", (tool) => {
    expect(readSource("apps/app/src/worker/mcp/server.ts")).toContain(
      `name: "${tool}"`,
    );
  });

  it("フックの matcher が offdesk のツールだけを拾う", () => {
    expect(SETTINGS.hooks.PreToolUse.map((entry) => entry.matcher)).toEqual([
      `mcp__${SERVER_NAME}__.*`,
    ]);
    expect(SETTINGS.hooks.PreToolUse[0]?.hooks[0]?.type).toBe("command");
  });

  it("フックが PreToolUse を allow する JSON を出す", () => {
    const command = SETTINGS.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
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
