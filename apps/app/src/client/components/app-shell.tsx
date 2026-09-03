import { Link, useRouterState } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/ui/breadcrumb";
import { Separator } from "@workspace/ui/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/ui/sidebar";
import { TooltipProvider } from "@workspace/ui/components/ui/tooltip";
import type { ReactNode } from "react";
import { navItemFor } from "../lib/nav.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export const AppShell = ({ children }: { children: ReactNode }) => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const current = navItemFor(pathname);

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex flex-1 items-center gap-2 px-4">
              <SidebarTrigger className="-ms-1" />
              <Separator
                orientation="vertical"
                className="me-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/" />}>
                      offdesk
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {current === undefined ? null : (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>{current.label}</BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  )}
                </BreadcrumbList>
              </Breadcrumb>
              <div className="ms-auto">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-4 p-4 pt-0">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
};
