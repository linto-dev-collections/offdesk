export type WorkerEnv = {
  DB: D1Database;
  PLANS: R2Bucket;
  GATEWAY: DurableObjectNamespace;

  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  AUTH_ALLOWED_EMAILS: string;

  LOCAL_DEV?: string;
};

export const PRODUCTION_REQUIRED_ENV_NAMES = [
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const satisfies readonly (keyof WorkerEnv)[];

export type AppBindings = {
  Bindings: WorkerEnv;
};

const isLocalDev = (env: Partial<WorkerEnv>): boolean =>
  env.LOCAL_DEV === "true";

const isBlank = (value: string | undefined): boolean =>
  value === undefined || value.trim() === "";

export function assertEnv(env: Partial<WorkerEnv>): void {
  const missing: string[] = [];

  if (env.DB === undefined) missing.push("DB");
  if (env.PLANS === undefined) missing.push("PLANS");
  if (env.GATEWAY === undefined) missing.push("GATEWAY");

  if (isBlank(env.BETTER_AUTH_SECRET)) missing.push("BETTER_AUTH_SECRET");
  if (isBlank(env.AUTH_ALLOWED_EMAILS)) missing.push("AUTH_ALLOWED_EMAILS");

  if (!isLocalDev(env)) {
    for (const name of PRODUCTION_REQUIRED_ENV_NAMES) {
      if (isBlank(env[name])) missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `必須のバインディング／環境変数が ${missing.length} 個ありません: ${missing.join(", ")}。\n` +
        "バインディングは apps/app/wrangler.jsonc と packages/infra/alchemy.run.ts の\n" +
        "両方を、環境変数は .env.example の一覧を確認してください。\n" +
        'ローカル開発でこれが出た場合は、wrangler.jsonc の vars に LOCAL_DEV="true" が\n' +
        "あるかを確認してください。",
    );
  }
}
