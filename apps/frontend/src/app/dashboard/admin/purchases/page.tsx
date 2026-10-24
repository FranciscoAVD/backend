import { RequirePermission } from "@/components/require-permission";
import { PurchasesView } from "@/features/admin/purchases-view";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function AdminPurchasesPage() {
  return (
    <RequirePermission permissions={{ purchase: ["read:all"] }}>
      <PurchasesView />
    </RequirePermission>
  );
}
