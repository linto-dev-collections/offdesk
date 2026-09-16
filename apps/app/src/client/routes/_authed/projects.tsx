import type {
  FireTokenProblem,
  ProjectConflict,
  ProjectSummary,
} from "@offdesk/contract";
import { isDefinedError } from "@orpc/client";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import {
  ProjectForm,
  type ProjectFormProblem,
  type ProjectFormValues,
} from "../../components/project-form.tsx";
import { ProjectTable } from "../../components/project-table.tsx";
import { RoutinePrompt } from "../../components/routine-prompt.tsx";
import { ErrorState, LoadingRows } from "../../components/states.tsx";
import { orpc } from "../../lib/orpc.ts";

/*
  プロジェクトの台帳（要件 `F-H1`〜`F-H5`）。

  **`projects.json` と CLI を畳んでここへ移した**（2026-09-16）。要件 §3-2 は
  画面からの CRUD を第2フェーズに置いたうえで「正本が D1 になっていれば、画面は
  後から足しても移行が起きない」と書いていて、実際に移行は 1 件も無かった。

  **消せない手順が 3 つ残る**（claude.ai の routine・その API トークン・Discord の
  チャンネル）。Claude Code の公開 API は `fire` の 1 本だけで、routine の作成も
  トークンの発行も口が無い —— だから画面は**「作ったものを登録する」までを持つ。**
*/

const FALLBACK: ProjectFormProblem = {
  field: null,
  message: "保存できませんでした。",
};

/**
 * サーバーが返した失敗を、欄に付ける印へ写す。**理由の文字列は出さない**（脅威 12）。
 *
 * **`data` は `unknown` で受ける。** 契約の型は分かっているが、これは**線を渡って
 * きた値** —— 出どころを信じて読むより、ここで 1 回確かめる方が安い。
 *
 * **`isDefinedError` の絞り込みは呼ぶ側で行う**（`operations.tsx` と同じ形）。
 * `unknown` に対して呼ぶと `never` に落ちて `code` が読めない。
 */
const problemFor = (code: string, data: unknown): ProjectFormProblem => {
  if (code === "CONFLICT") {
    const field = (data as Partial<ProjectConflict> | undefined)?.field;
    return field === "name"
      ? { field: "name", message: "この名前は既に使われています。" }
      : {
          field: "discordChannelId",
          message: "このチャンネルには既に別のプロジェクトが紐付いています。",
        };
  }

  if (code === "UNPROCESSABLE_CONTENT") {
    /*
      **3 つとも取るべき行動が違う**ので言い分ける（`FireTokenVerdict` の why）。
      トークンの値も応答の本文も出さない。
    */
    const kind = (data as Partial<FireTokenProblem> | undefined)?.kind;
    if (kind === "rejected") {
      return {
        field: "fireToken",
        message:
          "このトークンは通りませんでした。routine の API トリガで発行し直してください。",
      };
    }
    if (kind === "routine_not_found") {
      return {
        field: "fireUrl",
        message: "この URL の routine が見つかりません。貼り直してください。",
      };
    }
    return {
      field: null,
      message:
        "Anthropic へ届きませんでした。しばらくしてからもう一度試してください。",
    };
  }

  if (code === "SERVICE_UNAVAILABLE") {
    return {
      field: null,
      message:
        "FIRE_TOKEN_KEY が設定されていないので保存できません（OPERATIONS.md §1）。",
    };
  }

  if (code === "NOT_FOUND") {
    return {
      field: null,
      message:
        "このプロジェクトは見つかりませんでした。読み込み直してください。",
    };
  }

  return FALLBACK;
};

const Projects = () => {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(orpc.projects.list.queryOptions());
  const { data: channels } = useSuspenseQuery(
    orpc.projects.channels.queryOptions(),
  );

  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [problem, setProblem] = useState<ProjectFormProblem | null>(null);
  const [pendingSave, setPendingSave] = useState<ProjectFormValues | null>(
    null,
  );
  const [toggling, setToggling] = useState<ProjectSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: orpc.projects.list.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: orpc.projects.channels.queryKey(),
    });
  };

  /*
    **`/offdesk` を更新できたかを毎回見る。** 台帳に入っただけでは Discord の
    選択肢に新しい名前が出ない —— **画面には出るので気づきにくい**というのが
    OPERATIONS §2 がいちばん強く警告していた取りこぼしで、ここで言う。
  */
  const onWritten = (output: { commandsRegistered: boolean }): void => {
    setProblem(null);
    setFormOpen(false);
    setEditing(null);
    setToggling(null);
    refresh();
    setNotice(
      output.commandsRegistered
        ? null
        : "保存しましたが、/offdesk の選択肢を更新できませんでした。下のボタンでやり直してください。",
    );
  };

  const create = useMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: onWritten,
      onError: (error) =>
        setProblem(
          isDefinedError(error) ? problemFor(error.code, error.data) : FALLBACK,
        ),
    }),
  );

  const update = useMutation(
    orpc.projects.update.mutationOptions({
      onSuccess: onWritten,
      onError: (error) =>
        setProblem(
          isDefinedError(error) ? problemFor(error.code, error.data) : FALLBACK,
        ),
    }),
  );

  const setDisabled = useMutation(
    orpc.projects.setDisabled.mutationOptions({
      onSuccess: onWritten,
      onError: () => {
        setToggling(null);
        setNotice("状態を変えられませんでした。");
      },
    }),
  );

  const syncCommands = useMutation(
    orpc.projects.syncCommands.mutationOptions({
      onSuccess: (output) =>
        setNotice(
          `/offdesk の選択肢を更新しました（${output.registered.length} 件）。`,
        ),
      onError: () =>
        setNotice(
          "/offdesk を登録し直せませんでした。Discord の設定（OPERATIONS.md §3-4）を見てください。",
        ),
    }),
  );

  const saving = create.isPending || update.isPending;

  const submit = (values: ProjectFormValues): void => {
    /*
      **保存の前に 1 枚挟む**（`plans.remove` と同じ構え）。トークンは
      入れれば差し替わり、**前のトークンは戻らない** —— 押し間違いの代償が
      他の画面より重い。
    */
    setProblem(null);
    setPendingSave(values);
  };

  const commit = (): void => {
    const values = pendingSave;
    setPendingSave(null);
    if (values === null) return;

    if (editing === null) {
      create.mutate({
        name: values.name.trim(),
        discordChannelId: values.discordChannelId.trim(),
        repoUrl: values.repoUrl.trim(),
        fireUrl: values.fireUrl.trim(),
        fireToken: values.fireToken.trim(),
      });
      return;
    }

    const token = values.fireToken.trim();
    update.mutate({
      id: editing.id,
      discordChannelId: values.discordChannelId.trim(),
      repoUrl: values.repoUrl.trim(),
      fireUrl: values.fireUrl.trim(),
      // **空欄は送らない**（据え置き）。空文字で送ると Zod の下限で落ちる。
      ...(token === "" ? {} : { fireToken: token }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="font-medium text-lg">プロジェクト</h1>
          <p className="text-muted-foreground text-sm">
            claude.ai の routine と Discord
            のチャンネルを先に作り、ここで登録します。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => syncCommands.mutate({})}
            disabled={syncCommands.isPending}
          >
            {syncCommands.isPending ? "登録中…" : "/offdesk を登録し直す"}
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setProblem(null);
              setFormOpen(true);
            }}
          >
            増やす
          </Button>
        </div>
      </div>

      {notice === null ? null : (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      <ProjectTable
        items={data.items}
        onEdit={(project) => {
          setEditing(project);
          setProblem(null);
          setFormOpen(true);
        }}
        onToggleDisabled={setToggling}
        busy={setDisabled.isPending}
      />

      <RoutinePrompt />

      <ProjectForm
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setProblem(null);
        }}
        project={editing}
        channels={channels.items}
        channelsAvailable={channels.available}
        problem={problem}
        pending={saving}
        onSubmit={submit}
      />

      <ConfirmDialog
        open={pendingSave !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSave(null);
        }}
        title={
          editing === null
            ? "このプロジェクトを増やしますか"
            : "この内容で直しますか"
        }
        description={
          pendingSave !== null && pendingSave.fireToken.trim() !== ""
            ? "トークンを保存する前に Anthropic へ叩いて確かめます。入れたトークンは差し替えになり、前のものには戻せません。"
            : "トークンは据え置きで、チャンネル・リポジトリ・fire の URL だけを書き換えます。"
        }
        confirmLabel="保存する"
        onConfirm={commit}
        pending={saving}
      />

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => {
          if (!open) setToggling(null);
        }}
        title={
          toggling?.disabled === true
            ? `${toggling.name} を有効に戻しますか`
            : `${toggling?.name ?? ""} を止めますか`
        }
        description={
          toggling?.disabled === true
            ? "そのチャンネルの発言をまた受け付けるようになり、/offdesk の選択肢にも戻ります。"
            : "そのチャンネルからは起動できなくなり、/offdesk の選択肢からも消えます。run の履歴は残ります。"
        }
        confirmLabel={toggling?.disabled === true ? "有効に戻す" : "止める"}
        onConfirm={() => {
          if (toggling !== null) {
            setDisabled.mutate({
              id: toggling.id,
              disabled: !toggling.disabled,
            });
          }
        }}
        pending={setDisabled.isPending}
      />
    </div>
  );
};

const ProjectsError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <ErrorState
      title="プロジェクトの一覧を読み込めませんでした"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

export const Route = createFileRoute("/_authed/projects")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(orpc.projects.list.queryOptions()),
      context.queryClient.ensureQueryData(
        orpc.projects.channels.queryOptions(),
      ),
    ]),
  component: Projects,
  pendingComponent: () => <LoadingRows rows={5} />,
  errorComponent: ProjectsError,
});
