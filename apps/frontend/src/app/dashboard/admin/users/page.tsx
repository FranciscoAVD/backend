import { RequirePermission } from "@/components/require-permission";
import { UsersView } from "@/features/admin/users-view";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function AdminUsersPage() {
  return (
    <RequirePermission permissions={{ user: ["list"] }}>
      <UsersView />
    </RequirePermission>
  );
}
