import { RequirePermission } from "@/components/require-permission";
import { EditPlanForm } from "@/features/admin/edit-plan-form";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function EditPlanPage() {
  return (
    <RequirePermission permissions={{ plan: ["create", "update"] }}>
      <EditPlanForm />
    </RequirePermission>
  );
}
