import { RequirePermission } from "@/components/require-permission";
import { PlansView } from "@/features/admin/plans-view";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function AdminPlansPage() {
  return (
    <RequirePermission permissions={{ plan: ["create", "update"] }}>
      <PlansView />
    </RequirePermission>
  );
}
