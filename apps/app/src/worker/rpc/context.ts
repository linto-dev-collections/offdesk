import type { Auth } from "@offdesk/auth";
import type { WorkerEnv } from "../env.ts";

export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;

export type RpcContext = Readonly<{
  session: AuthSession;
  env: WorkerEnv;
  waitUntil: (promise: Promise<unknown>) => void;
}>;
