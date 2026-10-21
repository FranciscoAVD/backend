"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { cn } from "cn";

const TABS = [
  { href: "/dashboard/admin/audit", label: "Audit log" },
  { href: "/dashboard/admin/purchases", label: "Purchases" },
  { href: "/dashboard/admin/users", label: "Users" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();

  const isAdmin =
    !!session &&
    authClient.admin.checkRolePermission({
      role: (session.user.role ?? "user") as "user" | "admin",
      permissions: { audit: ["list"], purchase: ["read:all"], user: ["list"] },
    });

  useEffect(() => {
    if (!isPending && (!session || !isAdmin)) router.replace("/dashboard");
  }, [isPending, session, isAdmin, router]);

  if (isPending || !session || !isAdmin) return null;

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <nav className="flex gap-4 border-b border-black/[.08] pb-2 dark:border-white/[.145]">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "text-sm font-medium text-muted-foreground hover:text-foreground",
              pathname === tab.href && "text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
