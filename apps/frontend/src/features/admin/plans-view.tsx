"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { formatAmount } from "@/lib/currency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
    queryKey: ["admin", "plans"],
    queryFn: fetchPlans,
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading plans...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const plans = data.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/dashboard/admin/plans/new">New plan</Link>}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Active</TableHead>
            <TableHead>Repeatable</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Trial</TableHead>
            <TableHead>Overlapping</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground">
                No plans
              </TableCell>
            </TableRow>
          ) : (
            plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell className="font-medium">{plan.name}</TableCell>
                <TableCell>
                  {plan.type === "recurring" ? `recurring/${plan.interval}` : "one-time"}
                </TableCell>
                <TableCell>{formatAmount(plan.amount, plan.currency)}</TableCell>
                <TableCell>
                  <Badge variant={plan.active ? "default" : "secondary"}>
                    {plan.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {plan.type === "one_time" ? (plan.repeatable ? "Yes" : "No") : "—"}
                </TableCell>
                <TableCell>{plan.durationDays ?? "—"}</TableCell>
                <TableCell>{plan.trialDays ?? "—"}</TableCell>
                <TableCell>
                  {plan.type === "one_time" ? (plan.overlapping ? "Yes" : "No") : "—"}
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/dashboard/admin/plans/${plan.id}/edit`}>Edit</Link>}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
