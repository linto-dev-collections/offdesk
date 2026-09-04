import {
  BlueprintIcon,
  DashboardSquare01Icon,
  FolderLibraryIcon,
  PlayIcon,
  PlugSocketIcon,
} from "@hugeicons/core-free-icons";

/*
  サイドバーの並び（要件 §5-6 の 5 画面・§10-4 の枠）。

  **`kind: "planned"` を持たなくなった。** P7a では「まだ無い画面を押せない
  `<span>` ＋ フェーズのバッジで並べる」形にしてあったが（要件 §10-4）、
  P7b で 5 画面すべてが実装済みになったので**分岐そのものを消した** ——
  1 つしか残らない判別子は、読む人に「もう 1 つの形がある」と誤解させる。
  次に画面を増やすフェーズが来たら、その時点で戻す方が安い。
*/
export const NAV_GROUPS = [
  {
    label: "概要",
    items: [
      {
        label: "ダッシュボード",
        icon: DashboardSquare01Icon,
        to: "/",
      },
      {
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
        label: "計画",
        icon: BlueprintIcon,
        to: "/plans",
      },
      {
        label: "プロジェクト",
        icon: FolderLibraryIcon,
        to: "/projects",
      },
    ],
  },
  /*
    **入れ物の名前を「運用」から変えた。** 要件 §5-6 が画面の名前を「運用」と
    定めているので項目名はそちらに合わせ、**同じ文字が 2 行続くのを避ける**
    ために入れ物の名前をずらした（P7a では中身が「Gateway」だったので
    重ならなかった）。
  */
  {
    label: "システム",
    items: [
      {
        label: "運用",
        icon: PlugSocketIcon,
        to: "/operations",
      },
    ],
  },
] as const;

export type NavItem = (typeof NAV_GROUPS)[number]["items"][number];

/*
  **`flatMap<NavItem>` と型を明示する。** `as const` のタプルに対しては
  `U` が最初の要素から決まってしまって `TS2322` になる（P7a §9-5 で実測）。

  平らにした一覧を export しているのは、**テストが同じ `flatMap` を
  書き直さずに済むように**（書き直すと同じ罠を踏む）。
*/
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap<NavItem>(
  (group) => group.items,
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
  NAV_ITEMS.find((item) => item.to === pathname) ??
  NAV_ITEMS.find(
    (item) => item.to !== "/" && pathname.startsWith(`${item.to}/`),
  );
