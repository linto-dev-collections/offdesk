import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  HelpCircleIcon,
  InboxIcon,
  Message01Icon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  assertNever,
  type EventKind,
  formatJst,
  formatRelativeJst,
  type TimelineEntry,
} from "@offdesk/contract";
import { Badge } from "@workspace/ui/components/ui/badge";
import type { ReactNode } from "react";
import { EmptyState } from "./states.tsx";

/** `events_kind_ck` の 5 種すべて。**足すとここがコンパイルエラーになる。** */
const EVENT_LABELS: Record<EventKind, string> = {
  progress: "進捗",
  done: "完了",
  blocked: "詰まり",
  stop_hook: "ターン終わり",
  error: "エラー",
};

const EVENT_ICONS: Record<EventKind, IconSvgElement> = {
  progress: Message01Icon,
  done: CheckmarkCircle02Icon,
  blocked: HelpCircleIcon,
  stop_hook: PlayIcon,
  error: AlertCircleIcon,
};

const Body = ({ children }: { readonly children: ReactNode }) => (
  <p className="whitespace-pre-wrap break-words text-sm">{children}</p>
);

const Note = ({
  children,
  warn = false,
}: {
  readonly children: ReactNode;
  readonly warn?: boolean;
}) => (
  <p
    className={
      warn ? "text-destructive text-xs" : "text-muted-foreground text-xs"
    }
  >
    {children}
  </p>
);

type Rendered = {
  readonly icon: IconSvgElement;
  readonly label: string;
  readonly content: ReactNode;
};

/**
 * 1 行を描く。
 *
 * **`switch` ＋ `assertNever` にするのが要点**（計画 P7a §3-2）。
 * `TimelineEntry` は判別可能な合併なので、**種別を足すと `assertNever` の
 * 引数が `never` でなくなってコンパイルエラーになる。**
 */
const renderEntry = (entry: TimelineEntry): Rendered => {
  switch (entry.kind) {
    case "ask":
      return {
        icon: HelpCircleIcon,
        label: "質問",
        content: (
          <>
            <Body>{entry.question}</Body>
            {entry.options.length === 0 ? null : (
              <div className="flex flex-wrap gap-1">
                {entry.options.map((option) => (
                  <Badge key={option} variant="outline">
                    {option}
                  </Badge>
                ))}
              </div>
            )}
            {entry.answer === null ? (
              <Note>まだ答えが入っていません</Note>
            ) : (
              <Note>回答: {entry.answer}</Note>
            )}
            {/*
              **答えが入っているのに `delivered_at` が立っていない**のが
              いちばん気づきにくい壊れ方（要件 `I-3`）——「答えたのに動かない」に見える。
            */}
            {entry.answer !== null && entry.deliveredAt === null ? (
              <Note warn>答えは入っていますが Claude へ渡っていません</Note>
            ) : null}
          </>
        ),
      };

    case "event":
      return {
        icon: EVENT_ICONS[entry.eventKind],
        label: EVENT_LABELS[entry.eventKind],
        content: (
          <>
            <Body>{entry.body}</Body>
            {/* NULL ＝ 台帳には残っているが Discord には出ていない（要件 `N-7`）。 */}
            {entry.discordMessageId === null ? (
              <Note warn>Discord には出ていません</Note>
            ) : null}
          </>
        ),
      };

    case "inbox":
      return {
        icon: InboxIcon,
        label: "素の文",
        content: (
          <>
            <Body>{entry.body}</Body>
            {entry.takenAt === null ? (
              <Note>まだ渡していません</Note>
            ) : (
              <Note>渡した先: {entry.takenByRunKey}</Note>
            )}
          </>
        ),
      };

    default:
      return assertNever(entry);
  }
};

export const Timeline = ({
  entries,
  now,
}: {
  readonly entries: readonly TimelineEntry[];
  readonly now: number;
}) => {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Message01Icon}
        title="まだ記録がありません"
        hint="質問・進捗・素の文が届くとここに並びます"
      />
    );
  }

  return (
    <ol className="flex flex-col gap-4">
      {entries.map((entry, index) => {
        const rendered = renderEntry(entry);

        return (
          <li
            /*
              **3 表を混ぜた行に横断の id は無い。** `at` は同着しうるので
              種別と位置まで混ぜて key にしている（サーバーが並べた順が正）。
            */
            key={`${entry.kind}-${entry.at}-${index}`}
            className="flex gap-3 border-border border-b pb-4 last:border-b-0"
          >
            <HugeiconsIcon
              icon={rendered.icon}
              strokeWidth={2}
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-sm">{rendered.label}</span>
                <span className="text-muted-foreground text-xs">
                  {formatRelativeJst(entry.at, now)}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatJst(entry.at)}
                </span>
              </div>
              {rendered.content}
            </div>
          </li>
        );
      })}
    </ol>
  );
};
