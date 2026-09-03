import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");
const APP_DIR = path.join(REPO_ROOT, "apps/app");
const DIST = path.join(APP_DIR, "dist");

const CANARY = "offdesk-canary-4b7e2a91-must-not-reach-the-client";

const SECRET_ENV_NAMES = [
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "AUTH_ALLOWED_EMAILS",
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

beforeAll(() => {
  execFileSync("pnpm", ["-F", "app", "build"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      ...Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, CANARY])),
    },
  });
});

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
