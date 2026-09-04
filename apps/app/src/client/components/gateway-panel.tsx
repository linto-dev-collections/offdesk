import {
  AlertCircleIcon,
  Clock01Icon,
  PlugSocketIcon,
  RefreshIcon,
  Wifi01Icon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  formatJst,
  formatRelativeJst,
  type GatewayState,
  type GatewayStatus,
  gatewayFatalHint,
} from "@offdesk/contract";
import { Badge } from "@workspace/ui/components/ui/badge";
import { Button } from "@workspace/ui/components/ui/button";

type StateStyle = {
  readonly label: string;
  readonly variant: "default" | "secondary" | "destructive" | "outline";
  readonly icon: IconSvgElement;
  readonly className?: string;
};

/**
 * 5 状態すべてに 1 つずつ（`Record` にするのが分岐漏れの検査）。
 *
 * **塗り（`default`）を `fatal` に割り当てた。** run のバッジでは
 * 「人が動くまで進まない」`waiting` に割り当てたのと同じ理由 ——
 * `fatal` は**人が直すまで戻らない**唯一の状態で（要件 `F-I4`）、
 * ここに気づけないと素の文が届かないまま静かに止まる。
 */
const STATE_STYLES: Record<GatewayState, StateStyle> = {
  idle: { label: "停止中", variant: "outline", icon: Clock01Icon },
  connecting: { label: "接続中", variant: "secondary", icon: PlugSocketIcon },
  live: {
    label: "稼働中",
    variant: "outline",
    icon: Wifi01Icon,
    className: "text-muted-foreground",
  },
  backoff: {
    label: "再接続待ち",
    variant: "outline",
    icon: WifiDisconnected01Icon,
    className: "text-destructive",
  },
  fatal: { label: "停止（要対応）", variant: "default", icon: AlertCircleIcon },
};

export const gatewayStateLabel = (state: GatewayState): string =>
  STATE_STYLES[state].label;

const MS_PER_SECOND = 1000;

/** **`null` は「いま叩ける」。** 過ぎた時刻でも 0 に倒す（DO 側と同じ扱い）。 */
export const resetWaitSeconds = (
  status: GatewayStatus,
  nowMs: number,
): number => {
  if (status.resetAvailableAt === null) return 0;

  const remaining = status.resetAvailableAt - nowMs;
  return remaining <= 0 ? 0 : Math.ceil(remaining / MS_PER_SECOND);
};

const Field = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-muted-foreground text-xs">{label}</span>
    <div className="text-sm">{children}</div>
  </div>
);

/**
 * Gateway の状態と張り直し（要件 `F-I7`・`F-F4`・計画 P7b §3-3）。
 *
 * **状態を 1 つも持たない。** `now` も `pending` も呼ぶ側から受ける ——
 * 残り時間の表示に時計が要るが、それをここに置くと
 * 「テストで時間を作れない部品」になる。
 *
 * **`healthy` と `state === "live"` を別に出す**（計画 P4 §3-7）。
 * 一致しないことがあり（無音の深さも見る）、**食い違っているときが
 * いちばん知りたい状態** —— 繋がっているのに文が来ていない、が読める。
 */
export const GatewayPanel = ({
  status,
  now,
  onReset,
  resetPending = false,
}: {
  readonly status: GatewayStatus;
  readonly now: number;
  readonly onReset: () => void;
  readonly resetPending?: boolean;
}) => {
  const style = STATE_STYLES[status.state];
  const wait = resetWaitSeconds(status, now);
  const hint = gatewayFatalHint(status.fatalReason);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={style.variant} className={style.className}>
          <HugeiconsIcon
            icon={style.icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {style.label}
        </Badge>
        <span className="text-sm">
          {status.healthy ? "素の文が届いています" : "素の文が届いていません"}
        </span>
      </div>

      {/*
        **`fatal` のときだけ直し方を出す。** 文言は `packages/contract` の
        1 か所（`gatewayFatalHint`）—— `curl` で見る `hint` と同じ関数を引く。
      */}
      {hint === null ? null : (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            strokeWidth={2}
            className="mt-0.5 size-4 shrink-0"
          />
          <p>{hint}</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="ソケット">
          {status.connected ? (
            "開いています"
          ) : (
            <span className="text-muted-foreground">開いていません</span>
          )}
        </Field>
        <Field label="最後に届いたイベント">
          {status.lastEventAt === null ? (
            <span className="text-muted-foreground">まだありません</span>
          ) : (
            <>
              {formatRelativeJst(status.lastEventAt, now)}
              <span className="ms-2 text-muted-foreground text-xs tabular-nums">
                {formatJst(status.lastEventAt)}
              </span>
            </>
          )}
        </Field>
        <Field label="理由">
          {status.fatalReason === null ? (
            <span className="text-muted-foreground">なし</span>
          ) : (
            <span className="tabular-nums">{status.fatalReason}</span>
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/*
          **クライアントでも判定するが、サーバーでも必ず検査する**（脅威 15）。
          ここで無効にするのは「押しても 429 が返るだけ」を避けるためで、
          守りではない。
        */}
        <Button
          variant="outline"
          size="sm"
          disabled={wait > 0 || resetPending}
          onClick={onReset}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          張り直す
        </Button>
        {wait > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            あと {wait} 秒
          </span>
        ) : null}
      </div>

      {/*
        **直らない失敗は張り直しても戻らない**（要件 `F-I4`・計画 P4 §3-2）。
        押す前に設定を直す必要があることを、`fatal` のときだけ書く。
      */}
      {status.state === "fatal" ? (
        <p className="text-muted-foreground text-xs">
          設定を直してから張り直してください。直さずに押しても同じ理由で切られます。
        </p>
      ) : null}
    </div>
  );
};
