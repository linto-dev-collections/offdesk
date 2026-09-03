import { LogoutIcon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { authClient } from "@offdesk/auth/client";
import type { MeOutput } from "@offdesk/contract";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/ui/sidebar";

const initials = (me: MeOutput): string => {
  const source = me.name.trim().length > 0 ? me.name.trim() : me.email;
  return [...source].slice(0, 2).join("").toUpperCase();
};

const signOut = (): void => {
  void authClient.signOut().then(() => {
    window.location.assign("/login");
  });
};

export const NavUser = ({ me }: { me: MeOutput }) => {
  const { isMobile } = useSidebar();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />
            }
          >
            <Avatar>
              <AvatarImage
                src={me.imageUrl ?? undefined}
                alt={me.name}
                referrerPolicy="no-referrer"
              />
              <AvatarFallback>{initials(me)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">{me.name}</span>
              <span className="truncate text-xs">{me.email}</span>
            </div>
            <HugeiconsIcon
              icon={UnfoldMoreIcon}
              strokeWidth={2}
              className="ms-auto size-4"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-fit"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
                  <Avatar>
                    <AvatarImage
                      src={me.imageUrl ?? undefined}
                      alt={me.name}
                      referrerPolicy="no-referrer"
                    />
                    <AvatarFallback>{initials(me)}</AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-start text-sm leading-tight">
                    <span className="truncate font-medium">{me.name}</span>
                    <span className="truncate text-xs">{me.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <HugeiconsIcon icon={LogoutIcon} strokeWidth={2} />
              ログアウト
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
