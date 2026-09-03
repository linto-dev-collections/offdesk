import { ComputerTerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@workspace/ui/components/ui/sidebar";
import { NAV_GROUPS } from "../lib/nav.ts";
import { orpc } from "../lib/orpc.ts";
import { NavUser } from "./nav-user.tsx";

const STAGE = import.meta.env.DEV ? "dev" : "prod";

const Brand = () => (
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        render={<div />}
        className="cursor-default hover:bg-transparent hover:text-sidebar-foreground"
      >
        <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <HugeiconsIcon icon={ComputerTerminalIcon} strokeWidth={2} />
        </div>
        <div className="grid flex-1 text-start text-sm leading-tight">
          <span className="truncate font-medium">offdesk</span>
          <span className="truncate text-muted-foreground text-xs">
            {STAGE}
          </span>
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>
);

const Nav = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return NAV_GROUPS.map((group) => (
    <SidebarGroup key={group.label}>
      <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map((item) =>
          item.kind === "live" ? (
            <SidebarMenuItem key={item.label}>
              <SidebarMenuButton
                tooltip={item.label}
                isActive={item.to === pathname}
                render={<Link to={item.to} />}
              >
                <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            <SidebarMenuItem key={item.label}>
              <SidebarMenuButton
                tooltip={`${item.label}（${item.phase} で入ります）`}
                render={<span />}
                className="cursor-default opacity-60 hover:bg-transparent hover:text-sidebar-foreground"
              >
                <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                <span>{item.label}</span>
              </SidebarMenuButton>
              <SidebarMenuBadge className="text-muted-foreground">
                {item.phase}
              </SidebarMenuBadge>
            </SidebarMenuItem>
          ),
        )}
      </SidebarMenu>
    </SidebarGroup>
  ));
};

export const AppSidebar = () => {
  const { data: me } = useSuspenseQuery(orpc.me.queryOptions());

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <Nav />
      </SidebarContent>
      <SidebarFooter>
        <NavUser me={me} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
