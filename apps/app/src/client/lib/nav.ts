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
        kind: "planned",
        label: "run",
        icon: PlayIcon,
        phase: "P7a",
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

const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap<NavItem>(
  (group) => group.items,
);

export const navItemFor = (pathname: string): NavItem | undefined =>
  NAV_ITEMS.find((item) => item.kind === "live" && item.to === pathname);
