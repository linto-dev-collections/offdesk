import { readFileSync } from "node:fs";
import path from "node:path";
import { ProjectSyncInput } from "@offdesk/contract";

/**
 * `projects.json` を読んで検証する。**正本はこのファイル 1 つ。**
 *
 * **環境変数からは受け取らない。** `PROJECTS_JSON=… node …` と手で流し込めてしまうと、
 * 動作確認のつもりの 1 行が本番を上書きできる（kanata で実際に起きた）。CI も
 * 「secret をファイルに書き出してから呼ぶ」形にして、入口を 1 つに閉じる。
 *
 * 中に fire トークンが入るので `.gitignore` 済み。
 */
export const PROJECTS_PATH = path.join(
  import.meta.dirname,
  "../../../projects.json",
);

export type LoadedProjects = ProjectSyncInput["projects"];

export const loadProjects = (): LoadedProjects => {
  let raw: string;
  try {
    raw = readFileSync(PROJECTS_PATH, "utf8");
  } catch {
    throw new Error(
      `${PROJECTS_PATH} がありません。projects.example.json をコピーして作ってください。`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("projects.json が JSON として読めません");
  }

  // 配列でも `{ projects: [...] }` でも受ける（例ファイルは配列）。
  const input = Array.isArray(parsed) ? { projects: parsed } : parsed;

  const result = ProjectSyncInput.safeParse(input);
  if (!result.success) {
    /*
      **失敗しても値そのものはメッセージに載せない。** 載せると fire トークンが
      ターミナルとログに出る（plans/security.md 脅威 12）。
    */
    const lines = result.error.issues.map(
      (issue) => `  - projects.${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`projects.json の形が違います:\n${lines.join("\n")}`);
  }

  return result.data.projects;
};

/** 何を送るかだけ見せる（要件 `F-H3`）。**トークンは末尾 4 文字だけ。** */
export const describeProjects = (projects: LoadedProjects): string =>
  projects
    .map((project) => {
      const host = project.fireUrl.slice("https://".length).split("/")[0] ?? "";
      return [
        `  - ${project.name}`,
        `      channel  ${project.discordChannelId}`,
        `      repo     ${project.repoUrl}`,
        `      fire     ${host}（…${project.fireToken.slice(-4)}）`,
      ].join("\n");
    })
    .join("\n");

export const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
};

export const offdeskFetch = async (
  pathname: string,
  init: { method: string; body?: unknown },
): Promise<unknown> => {
  const base = requireEnv("OFFDESK_URL").replace(/\/+$/, "");
  const token = requireEnv("OFFDESK_TOKEN");

  const response = await fetch(`${base}${pathname}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) {
    // 応答本文は出す（offdesk 自身の検証エラーで、秘密を含まない設計にしてある）。
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`offdesk が ${response.status} を返しました: ${detail}`);
  }

  return await response.json();
};
