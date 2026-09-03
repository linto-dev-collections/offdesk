import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

/*
  P0 の空の画面。**shadcn の button がここに出ることが `V-7` の確認**
  （Biome へ寄せた構成でも `shadcn add` が通り、生成物が画面に出る）。
  中身は P1 でログイン画面に、P7a でダッシュボードに置き換わる。
*/
const Index = () => (
  <div className="flex min-h-svh p-6">
    <div className="flex min-w-0 max-w-md flex-col gap-4 text-sm leading-loose">
      <div>
        <h1 className="font-medium">offdesk</h1>
        <p>骨格だけの状態です（P0）。</p>
        <Button className="mt-2">Button</Button>
      </div>
      <div className="font-mono text-muted-foreground text-xs">
        (<kbd>d</kbd> で暗い配色に切り替わります)
      </div>
    </div>
  </div>
);

export const Route = createFileRoute("/")({
  component: Index,
});
