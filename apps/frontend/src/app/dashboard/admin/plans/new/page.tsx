import { RequirePermission } from "@/components/require-permission";
import { CreatePlanForm } from "@/features/admin/create-plan-form";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function NewPlanPage() {
  return (
    <RequirePermission permissions={{ plan: ["create", "update"] }}>
      <h1 className="mb-4 text-lg font-medium">New plan</h1>
      <CreatePlanForm />
    </RequirePermission>
  );
}
