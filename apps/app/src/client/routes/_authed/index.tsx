import {
  AlertCircleIcon,
  HelpCircleIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";

type SummaryCard = {
  title: string;
  description: string;
  icon: IconSvgElement;
  empty: string;
  phase: string;
};

const CARDS: readonly SummaryCard[] = [
  {
    title: "走っている run",
    description: "queued / running / waiting を新しい順に 10 件",
    icon: PlayIcon,
    empty: "走っている run はありません",
    phase: "P2 で台帳に行が入ります",
  },
  {
    title: "未回答の ask",
    description: "まだ Discord へ出ていない、または答えが返っていない質問",
    icon: HelpCircleIcon,
    empty: "未回答の ask はありません",
    phase: "P3a で握りが入ります",
  },
  {
    title: "直近の失敗",
    description: "failed / abandoned を新しい順に 5 件",
    icon: AlertCircleIcon,
    empty: "直近の失敗はありません",
    phase: "P2 で台帳に行が入ります",
  },
];

const Dashboard = () => (
  <div className="flex flex-col gap-4">
    <div className="grid auto-rows-min gap-4 md:grid-cols-3">
      {CARDS.map((card) => (
        <Card key={card.title}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon
                icon={card.icon}
                strokeWidth={2}
                className="size-4 text-muted-foreground"
              />
              {card.title}
            </CardTitle>
            <CardDescription>{card.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <p className="text-muted-foreground text-sm">{card.empty}</p>
            <p className="text-muted-foreground text-xs">{card.phase}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  </div>
);

export const Route = createFileRoute("/_authed/")({
  component: Dashboard,
});
