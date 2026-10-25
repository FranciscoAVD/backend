import { PurchasesView } from "@/features/payments/purchases-view";

// see dashboard/page.tsx's comment on this export
export const instant = false;

export default function PurchasesPage() {
  return (
    <div>
      <h1 className="mb-4 text-lg font-medium">My purchases</h1>
      <PurchasesView />
    </div>
  );
}
