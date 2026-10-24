import { RequirePermission } from "@/components/require-permission";
import { AuditLogView } from "@/features/admin/audit-log-view";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function AdminAuditPage() {
  return (
    <RequirePermission permissions={{ audit: ["list"] }}>
      <AuditLogView />
    </RequirePermission>
  );
}
