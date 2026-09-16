import type { DiscordChannelOption, ProjectSummary } from "@offdesk/contract";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/ui/field";
import { Input } from "@workspace/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/ui/sheet";
import { useEffect, useId, useState } from "react";

/*
  プロジェクトを増やす・直すフォーム（要件 §3-2 が第2フェーズに置いていた画面）。

  **`fireUrl` の規則をここに書かない。** `https://api.anthropic.com/` の文字列を
  client に置くと `release/bundle-has-no-secrets.test.ts` が落ちる ——
  形の検査はサーバー側の Zod（`ProjectCreateInput`）が持ち、ここは
  **返ってきた理由を読める日本語に変えるだけ。**

  **入力の検査を 2 か所に書かない**という判断でもある（`contract` の
  「受け側で閉じておくのが唯一の防具」と同じ構え）。空欄だけは押せなくする ——
  あれは規則ではなく「まだ書いていない」なので。
*/

export type ProjectFormValues = {
  readonly name: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  readonly fireToken: string;
};

const EMPTY: ProjectFormValues = {
  name: "",
  discordChannelId: "",
  repoUrl: "",
  fireUrl: "",
  fireToken: "",
};

const valuesOf = (project: ProjectSummary | null): ProjectFormValues =>
  project === null
    ? EMPTY
    : {
        name: project.name,
        discordChannelId: project.discordChannelId,
        repoUrl: project.repoUrl,
        /*
          **`fireUrl` は一覧に無い**（host しか返していない。脅威 3）ので、
          直すときは空から入れ直す —— 出さない判断を、編集のために緩めない。
        */
        fireUrl: "",
        fireToken: "",
      };

/** 押せるか。**規則ではなく「まだ書いていない」だけを見る。** */
const ready = (
  values: ProjectFormValues,
  mode: "create" | "update",
): boolean => {
  const filled = (value: string): boolean => value.trim() !== "";

  if (!filled(values.discordChannelId)) return false;
  if (!filled(values.repoUrl)) return false;
  if (!filled(values.fireUrl)) return false;
  if (mode === "create") return filled(values.name) && filled(values.fireToken);

  // 直すときのトークンは据え置きでよい（`ProjectUpdateInput` の why）。
  return true;
};

export type ProjectFormProblem = {
  /** 欄に印を付ける先。`null` なら全体の注意書きだけ。 */
  readonly field: keyof ProjectFormValues | null;
  readonly message: string;
};

export const ProjectForm = ({
  open,
  onOpenChange,
  project,
  channels,
  channelsAvailable,
  problem,
  pending,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `null` なら新規。 */
  readonly project: ProjectSummary | null;
  readonly channels: readonly DiscordChannelOption[];
  readonly channelsAvailable: boolean;
  readonly problem: ProjectFormProblem | null;
  readonly pending: boolean;
  readonly onSubmit: (values: ProjectFormValues) => void;
}) => {
  const mode = project === null ? "create" : "update";
  const [values, setValues] = useState<ProjectFormValues>(() =>
    valuesOf(project),
  );
  const ids = {
    name: useId(),
    channel: useId(),
    repo: useId(),
    fireUrl: useId(),
    fireToken: useId(),
  };

  /*
    **開き直したら入れ直す。** 閉じたときに消さないのは、保存に失敗した直後の
    入力を握っておくため —— 別の行の「編集」を押したときに前の値が残ると、
    **違うプロジェクトの URL を保存してしまう。**
  */
  useEffect(() => {
    if (open) setValues(valuesOf(project));
  }, [open, project]);

  const set = (key: keyof ProjectFormValues, value: string): void =>
    setValues((current) => ({ ...current, [key]: value }));

  const errorFor = (field: keyof ProjectFormValues): string | null =>
    problem?.field === field ? problem.message : null;

  /*
    **選べるのは空いているチャンネルだけ**（要件 `F-H4`）。
    直すときは自分がいま握っているものも選べる（変えない編集を通すため）。
  */
  const selectable = channels.filter(
    (channel) => !channel.taken || channel.id === project?.discordChannelId,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {mode === "create"
              ? "プロジェクトを増やす"
              : `${project?.name} を直す`}
          </SheetTitle>
          <SheetDescription>
            claude.ai の routine と Discord
            のチャンネルは先に作っておいてください。 ここで登録すると{" "}
            <code>/offdesk</code> の選択肢も更新されます。
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex flex-1 flex-col gap-6 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready(values, mode) && !pending) onSubmit(values);
          }}
        >
          <FieldGroup>
            {mode === "create" ? (
              <Field data-invalid={errorFor("name") !== null}>
                <FieldLabel htmlFor={ids.name}>名前</FieldLabel>
                <Input
                  id={ids.name}
                  value={values.name}
                  autoComplete="off"
                  placeholder="offdesk-test"
                  onChange={(event) => set("name", event.target.value)}
                />
                <FieldDescription>
                  英小文字・数字・<code>_</code> <code>-</code> だけ。
                  <strong>あとから変えられません</strong>（一致の鍵です）。
                </FieldDescription>
                <FieldError>{errorFor("name")}</FieldError>
              </Field>
            ) : null}

            <Field data-invalid={errorFor("discordChannelId") !== null}>
              <FieldLabel htmlFor={ids.channel}>Discord チャンネル</FieldLabel>
              {/*
                **一覧に出ること自体が「bot が見えている」の確認になる。**
                Discord は bot に View Channels があるものしか返さないので、
                OPERATIONS §2 の目視の手順がここで済む。
              */}
              {channelsAvailable ? (
                <Select
                  value={values.discordChannelId}
                  onValueChange={(value) =>
                    set("discordChannelId", value ?? "")
                  }
                >
                  <SelectTrigger id={ids.channel} className="w-full">
                    <SelectValue placeholder="チャンネルを選ぶ" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectable.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        #{channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={ids.channel}
                  value={values.discordChannelId}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="123456789012345678"
                  onChange={(event) =>
                    set("discordChannelId", event.target.value)
                  }
                />
              )}
              <FieldDescription>
                {channelsAvailable
                  ? "bot が見えているチャンネルだけが並びます。既に使われているものは出ません。"
                  : "チャンネルを引けませんでした（DISCORD_GUILD_ID か DISCORD_BOT_TOKEN）。id を貼ってください。"}
              </FieldDescription>
              <FieldError>{errorFor("discordChannelId")}</FieldError>
            </Field>

            <Field data-invalid={errorFor("repoUrl") !== null}>
              <FieldLabel htmlFor={ids.repo}>リポジトリ URL</FieldLabel>
              <Input
                id={ids.repo}
                value={values.repoUrl}
                autoComplete="off"
                placeholder="https://github.com/owner/repo"
                onChange={(event) => set("repoUrl", event.target.value)}
              />
              <FieldDescription>
                表示用です（要件 <code>F-H6</code>）。セッションが触れる範囲を
                決めるのは routine
                の側で、ここに書いても触れるようにはなりません。
              </FieldDescription>
              <FieldError>{errorFor("repoUrl")}</FieldError>
            </Field>

            <Field data-invalid={errorFor("fireUrl") !== null}>
              <FieldLabel htmlFor={ids.fireUrl}>fire の URL</FieldLabel>
              <Input
                id={ids.fireUrl}
                value={values.fireUrl}
                autoComplete="off"
                /*
                  **見本にホスト名を書かない。** この文字列が client のバンドルに
                  載ると `release/bundle-has-no-secrets.test.ts` が落ちる ——
                  「サーバー側の形が混ざっていない」を機械で言うための走査なので、
                  見本のためにそこを緩めない（宛先は下の説明文で案内している）。
                */
                placeholder="… /v1/claude_code/routines/…/fire"
                onChange={(event) => set("fireUrl", event.target.value)}
              />
              <FieldDescription>
                routine の API トリガに出ている URL です。
                {mode === "update"
                  ? " 一覧にはホストしか出ないので、直すときは入れ直してください。"
                  : null}
              </FieldDescription>
              <FieldError>{errorFor("fireUrl")}</FieldError>
            </Field>

            <Field data-invalid={errorFor("fireToken") !== null}>
              <FieldLabel htmlFor={ids.fireToken}>
                fire のトークン
                {mode === "update" ? "（空欄なら据え置き）" : null}
              </FieldLabel>
              {/*
                **`type="password"` にする。** 肩越しに見えるのを防ぐためというより、
                ブラウザとパスワード管理に「これは秘密」と伝えるため。
                `autoComplete="new-password"` で既存の資格情報を挿させない。
              */}
              <Input
                id={ids.fireToken}
                type="password"
                value={values.fireToken}
                autoComplete="new-password"
                placeholder={mode === "update" ? "変えないなら空のまま" : ""}
                onChange={(event) => set("fireToken", event.target.value)}
              />
              <FieldDescription>
                保存の前に<strong>実際に Anthropic へ叩いて確かめます</strong>
                （セッションは作りません）。
                {mode === "update"
                  ? " 一度しか表示されないので、手元に無いなら空のままにしてください。"
                  : null}
              </FieldDescription>
              <FieldError>{errorFor("fireToken")}</FieldError>
            </Field>
          </FieldGroup>

          {problem?.field === null ? (
            <p className="text-destructive text-sm">{problem.message}</p>
          ) : null}

          <SheetFooter className="px-0">
            <Button type="submit" disabled={!ready(values, mode) || pending}>
              {pending ? "確かめています…" : "保存する"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              やめる
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
};
