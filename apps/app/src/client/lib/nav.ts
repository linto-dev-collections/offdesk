import {
  BlueprintIcon,
  DashboardSquare01Icon,
  FolderLibraryIcon,
  PlayIcon,
  PlugSocketIcon,
} from "@hugeicons/core-free-icons";

export const NAV_GROUPS = [
  {
    label: "概要",
    items: [
      {
        kind: "live",
        label: "ダッシュボード",
        icon: DashboardSquare01Icon,
        to: "/",
      },
      {
        kind: "live",
        label: "run",
        icon: PlayIcon,
        to: "/runs",
      },
    ],
  },
  {
    label: "資料",
    items: [
      {
        kind: "planned",
        label: "計画",
        icon: BlueprintIcon,
        phase: "P7b",
      },
      {
        kind: "planned",
        label: "プロジェクト",
        icon: FolderLibraryIcon,
        phase: "P7b",
      },
    ],
  },
  {
    label: "運用",
    items: [
      {
        kind: "planned",
        label: "Gateway",
        icon: PlugSocketIcon,
        phase: "P7b",
      },
    ],
  },
] as const;

export type NavItem = (typeof NAV_GROUPS)[number]["items"][number];
type LiveNavItem = Extract<NavItem, { kind: "live" }>;

/*
  **`flatMap<NavItem>` と型を明示する。** `as const` のタプルに対しては
  `U` が最初の要素から決まってしまって `TS2322` になる（P7a §9-5 で実測）。

  平らにした一覧を export しているのは、**テストが同じ `flatMap` を
  書き直さずに済むように**（書き直すと同じ罠を踏む）。
*/
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap<NavItem>(
  (group) => group.items,
);

const LIVE_ITEMS: readonly LiveNavItem[] = NAV_ITEMS.filter(
  (item): item is LiveNavItem => item.kind === "live",
);

/**
 * 今いる場所に当たる項目（サイドバーの強調とパンくずの 2 段目）。
 *
 * **完全一致を先に見て、それから前方一致。** `/runs/$runKey` を開いたときも
 * サイドバーの「run」が光る必要があるが、**前方一致だけにすると `/` が
 * 全ページに当たる**（P7a §9-4 でそこを避けて完全一致だけにしてあった。
 * 入れ子のルートが入ったこの時点で 2 段にした）。
 *
 * 区切りを含めて（`` `${to}/` ``）比べているので、`/runs` は `/runsomething` に
 * 当たらない。
 */
export const navItemFor = (pathname: string): NavItem | undefined =>
  LIVE_ITEMS.find((item) => item.to === pathname) ??
  LIVE_ITEMS.find(
    (item) => item.to !== "/" && pathname.startsWith(`${item.to}/`),
  );
