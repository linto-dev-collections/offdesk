import type { Auth } from "@offdesk/auth";
import type { WorkerEnv } from "../env.ts";

/** `auth.api.getSession()` の戻り。ログインしていなければ `null`。 */
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;

/**
 * oRPC の手続きが受け取る文脈。
 *
 * **セッションの解決は Hono のミドルウェアで先に済ませ、ここには解決済みの値だけ渡す。**
 * 手続きの中で認証をやり直さない（要件 §10-2 の「入口とゲートだけ」）。
 *
 * `env` を丸ごと入れるのは D1 と R2 に届かせるため。**手続きの側から秘密を読まない**
 * 規約にする（読むのはアダプタ）。P2 以降はここへ port を足す。
 */
export type RpcContext = Readonly<{
  session: AuthSession;
  env: WorkerEnv;
  /** レスポンスを返した後も走らせたい処理（P4 以降の best-effort な後始末）。 */
  waitUntil: (promise: Promise<unknown>) => void;
}>;
