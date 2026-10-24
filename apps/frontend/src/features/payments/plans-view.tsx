"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { formatAmount } from "@/lib/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

async function fetchPlans() {
  const res = await apiClient.api.payments.plans.$get();

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to load plans");
  }

  return res.json();
}

export function PlansView() {
  const { data, error, isPending } = useQuery({
    queryKey: ["payments", "plans"],
    queryFn: fetchPlans,
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading plans...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const plans = data.data;

  if (plans.length === 0) return <p className="text-sm text-muted-foreground">No plans available</p>;

  return (
    <div className="grid w-full gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {plans.map((plan) => (
        <Card key={plan.id}>
          <CardHeader>
            <CardTitle>{plan.name}</CardTitle>
            <CardDescription>
              {formatAmount(plan.amount, plan.currency)}
              {plan.type === "recurring" ? `/${plan.interval}` : ""}
              {plan.annualAmount != null
                ? ` (or ${formatAmount(plan.annualAmount, plan.currency)}/year)`
                : ""}
            </CardDescription>
          </CardHeader>
          {plan.trialDays != null && (
            <CardContent>
              <p className="text-sm text-muted-foreground">{plan.trialDays}-day free trial</p>
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  );
}
