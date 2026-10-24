import { authClient } from "@/lib/auth-client";

type CheckRolePermissionArgs = Parameters<typeof authClient.admin.checkRolePermission>[0];
export type Role = CheckRolePermissionArgs["role"];
export type Permissions = CheckRolePermissionArgs["permissions"];

export function hasPermission(role: Role | undefined, permissions?: Permissions): boolean {
  if (!permissions) return true;
  if (!role) return false;
  return authClient.admin.checkRolePermission({ role, permissions });
}

export function useHasPermission(permissions?: Permissions): boolean {
  const { data: session } = authClient.useSession();
  const role = session ? ((session.user.role ?? "user") as Role) : undefined;
  return hasPermission(role, permissions);
}
