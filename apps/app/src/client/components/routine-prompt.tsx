import { useQuery } from "@tanstack/react-query";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/ui/collapsible";
import { useState } from "react";
import { orpc } from "../lib/orpc.ts";

/*
  claude.ai の routine に貼る本文（`pnpm routine:prompt` を畳んだ先）。

  **サーバーから引く。** 正本は `packages/domain` の `ROUTINE_PROMPT` で、
  クライアントに焼き込むと**デプロイしていない版の文面を配る**ことになる ——
  プロンプトは routine に焼き込まれるので、ズレても静かに動き続ける
  （OPERATIONS §2 が「直したら routine 全部に貼り直す」と書いている理由）。

  **畳んである。** 2KB の文面を常に開いておくと一覧が読めなくなるし、
  必要なのは routine を作るときの 1 回だけ。
*/

const COPIED_MS = 2_000;

export const RoutinePrompt = () => {
  const { data, isPending, isError } = useQuery(
    orpc.projects.routinePrompt.queryOptions(),
  );
  const [copied, setCopied] = useState(false);

  const copy = (prompt: string): void => {
    void navigator.clipboard.writeText(prompt).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {
        // **黙って失敗させない**（要件 `N-7`）。選んで自分で copy できる形は残っている。
        setCopied(false);
      },
    );
  };

  return (
    <Collapsible className="rounded-md border">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-sm">
        <span className="font-medium">routine に貼るプロンプト</span>
        <span className="text-muted-foreground text-xs">
          claude.ai で routine を作るときに使います
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-3">
        {isPending ? (
          <p className="text-muted-foreground text-sm">読み込んでいます…</p>
        ) : isError || data === undefined ? (
          <p className="text-muted-foreground text-sm">
            読み込めませんでした。読み込み直してください。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                <strong>
                  直したら既に在る routine 全部に貼り直してください。
                </strong>
                プロンプトは routine
                に焼き込まれるので、直しても勝手には届きません。
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy(data.prompt)}
              >
                {copied ? "コピーしました" : "コピー"}
              </Button>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {data.prompt}
            </pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
};
