"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { hasPermission, type Permissions, type Role } from "@/lib/permissions";

type RequirePermissionProps = {
  permissions: Permissions;
  redirectTo?: string;
  children: React.ReactNode;
};

export function RequirePermission({
  permissions,
  redirectTo = "/dashboard",
  children,
}: RequirePermissionProps) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const role = session ? ((session.user.role ?? "user") as Role) : undefined;
  const allowed = hasPermission(role, permissions);

  useEffect(() => {
    if (!isPending && !allowed) router.replace(redirectTo);
  }, [isPending, allowed, redirectTo, router]);

  if (isPending || !allowed) return null;

  return <>{children}</>;
}
