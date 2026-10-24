import { PlansView } from "@/features/payments/plans-view";

// this segment only ever renders once the parent layout's client-side session check passes,
// so it can't be statically validated for Next's instant-navigation optimization
export const instant = false;

export default function DashboardPage() {
  return (
    <div>
      <h1 className="mb-4 text-lg font-medium">Plans</h1>
      <PlansView />
    </div>
  );
}
