import { ROUTINE_PROMPT } from "@offdesk/domain";

/*
  claude.ai の routine に貼り付ける本文を出す。

  正本は `packages/domain/src/prompt.ts` の `ROUTINE_PROMPT`。
  **ここを直したら routine 側も貼り直すこと**（ズレても静かに動き続ける）。
*/
console.log(ROUTINE_PROMPT);
