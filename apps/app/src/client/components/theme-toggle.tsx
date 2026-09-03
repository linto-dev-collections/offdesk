import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/ui/button";
import { useTheme } from "./theme-provider.tsx";

export const ThemeToggle = () => {
  const { toggleTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleTheme}
      aria-label="テーマを切り替える"
      title="テーマを切り替える（d）"
    >
      <HugeiconsIcon
        icon={Sun03Icon}
        strokeWidth={2}
        className="hidden dark:block"
      />
      <HugeiconsIcon
        icon={Moon02Icon}
        strokeWidth={2}
        className="block dark:hidden"
      />
    </Button>
  );
};
