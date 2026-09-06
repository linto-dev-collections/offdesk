import {
  FolderLibraryIcon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ProjectSummary } from "@offdesk/contract";
import { Badge } from "@workspace/ui/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/ui/table";
import { MaskedToken } from "./masked-token.tsx";
import { EmptyState } from "./states.tsx";

const OutLink = ({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
  >
    <HugeiconsIcon
      icon={LinkSquare02Icon}
      strokeWidth={2}
      className="size-3.5"
    />
    {children}
  </a>
);

/** `https://github.com/owner/repo` を `owner/repo` に畳む（横幅のため）。 */
const repoLabel = (repoUrl: string): string => {
  try {
    return new URL(repoUrl).pathname.replace(/^\//, "");
  } catch {
    return repoUrl;
  }
};

/**
 * プロジェクト一覧（要件 `I-1`・計画 P7b §3-2）。
 *
 * **「分母」の列は持たない。** 計画 §3-2 は `contextWindowTokens` を挙げているが、
 * あの列は 2026-09-04 に廃止済み（分母を決めるのは**モデル**で、プロジェクトでは
 * ない。テーブル定義書 §4-1・要件 §11 の 9）—— run ごとの使用量は run 詳細で
 * モデル名つきで出る。
 *
 * **編集の口を持たない**（要件 §3-2 の「CRUD は第2フェーズ」）。
 * できないことを画面に書くのは呼ぶ側の仕事（`_authed/projects.tsx`）。
 */
export const ProjectTable = ({
  items,
}: {
  readonly items: readonly ProjectSummary[];
}) => {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={FolderLibraryIcon}
        title="プロジェクトがありません"
        hint="projects.json を書いて pnpm projects:sync で投入してください"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名前</TableHead>
            <TableHead>チャンネル</TableHead>
            <TableHead>リポジトリ</TableHead>
            <TableHead>fire の宛先</TableHead>
            <TableHead>トークン</TableHead>
            <TableHead>状態</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((project) => (
            <TableRow key={project.id}>
              <TableCell className="font-medium">{project.name}</TableCell>
              <TableCell className="whitespace-nowrap">
                {project.channelUrl === null ? (
                  <span
                    className="text-muted-foreground text-xs tabular-nums"
                    title="DISCORD_GUILD_ID が未設定なので、リンクは組めません"
                  >
                    {project.discordChannelId}
                  </span>
                ) : (
                  <OutLink href={project.channelUrl}>
                    {project.discordChannelId}
                  </OutLink>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <OutLink href={project.repoUrl}>
                  {repoLabel(project.repoUrl)}
                </OutLink>
              </TableCell>
              {/*
                **ホストだけ**（脅威 3）。URL 全体には `trig_…` が埋まっていて、
                それ 1 つ（＋トークン）で起動できる —— 応答の型にも入っていない。
              */}
              <TableCell className="whitespace-nowrap text-xs">
                {project.fireUrlHost}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <MaskedToken last4={project.fireTokenLast4} />
              </TableCell>
              <TableCell>
                {/*
                  **無効なものも一覧に出す**（要件 `F-H5`）。棚卸しに要るので
                  隠さず、印だけ付ける。
                */}
                {project.disabled ? (
                  <Badge variant="outline" className="text-destructive">
                    無効
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    有効
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
