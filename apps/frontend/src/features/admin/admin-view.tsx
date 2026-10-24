"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { AuditLogView } from "@/features/admin/audit-log-view";
import { PurchasesView } from "@/features/admin/purchases-view";
import { UsersView } from "@/features/admin/users-view";
import { PlansView } from "@/features/admin/plans-view";

const TABS = [
  { id: "audit", label: "Audit log" },
  { id: "purchases", label: "Purchases" },
  { id: "users", label: "Users" },
  { id: "plans", label: "Plans" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AdminView() {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("audit");
  const { data: session, isPending } = authClient.useSession();

  const isAdmin =
    !!session &&
    authClient.admin.checkRolePermission({
      role: (session.user.role ?? "user") as "user" | "admin",
      permissions: {
        audit: ["list"],
        purchase: ["read:all"],
        user: ["list"],
        plan: ["create", "update"],
      },
    });

  useEffect(() => {
    if (!isPending && (!session || !isAdmin)) router.replace("/dashboard");
  }, [isPending, session, isAdmin, router]);

  if (isPending || !session || !isAdmin) return null;

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            authClient.signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })
          }
        >
          Sign out
        </Button>
      </div>
      <nav className="flex gap-4 border-b border-black/[.08] pb-2 dark:border-white/[.145]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "text-sm font-medium text-muted-foreground hover:text-foreground",
              tab === t.id && "text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "audit" && <AuditLogView />}
      {tab === "purchases" && <PurchasesView />}
      {tab === "users" && <UsersView />}
      {tab === "plans" && <PlansView />}
    </div>
  );
}
