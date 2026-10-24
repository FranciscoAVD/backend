"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CreditCard,
  Receipt,
  ScrollText,
  Settings,
  Users as UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { hasPermission, type Permissions, type Role } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type NavItem = { label: string; href: string; icon: LucideIcon; permissions?: Permissions };
type NavGroup = { label?: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  { items: [{ label: "Plans", href: "/dashboard", icon: CreditCard }] },
  {
    label: "Admin",
    items: [
      {
        label: "Audit log",
        href: "/dashboard/admin/audit",
        icon: ScrollText,
        permissions: { audit: ["list"] },
      },
      {
        label: "Purchases",
        href: "/dashboard/admin/purchases",
        icon: Receipt,
        permissions: { purchase: ["read:all"] },
      },
      {
        label: "Users",
        href: "/dashboard/admin/users",
        icon: UsersIcon,
        permissions: { user: ["list"] },
      },
      {
        label: "Manage plans",
        href: "/dashboard/admin/plans",
        icon: Settings,
        permissions: { plan: ["create", "update"] },
      },
    ],
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const role = session ? ((session.user.role ?? "user") as Role) : undefined;

  return (
    <Sidebar>
      <SidebarContent>
        {NAV_GROUPS.map((group, groupIndex) => {
          const visibleItems = group.items.filter((item) => hasPermission(role, item.permissions));
          if (visibleItems.length === 0) return null;

          return (
            <SidebarGroup key={group.label ?? groupIndex}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {visibleItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={pathname === item.href}
                        render={
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.label}</span>
                          </Link>
                        }
                      />
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        {session && (
          <div className="flex flex-col gap-2 p-2">
            <p className="truncate text-sm text-muted-foreground">{session.user.email}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                authClient.signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })
              }
            >
              Sign out
            </Button>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
