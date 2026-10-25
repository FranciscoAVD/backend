"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { formatAmount } from "@/lib/currency";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const STATUS_VARIANT = {
  paid: "default",
  refunded: "secondary",
  disputed: "destructive",
} as const;

async function fetchPurchases() {
  const res = await apiClient.api.payments.purchases.$get();

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to load purchases");
  }

  return res.json();
}

function accessLabel(purchase: { accessStartsAt: string | null; accessEndsAt: string | null }) {
  if (!purchase.accessStartsAt) return { text: "No access", variant: "secondary" as const };
  if (!purchase.accessEndsAt) return { text: "Active, no expiry", variant: "default" as const };

  const endsAt = new Date(purchase.accessEndsAt);
  if (endsAt.getTime() > Date.now()) {
    return { text: `Active until ${endsAt.toLocaleDateString()}`, variant: "default" as const };
  }
  return { text: `Expired ${endsAt.toLocaleDateString()}`, variant: "secondary" as const };
}

export function PurchasesView() {
  const { data, error, isPending } = useQuery({
    queryKey: ["payments", "purchases"],
    queryFn: fetchPurchases,
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading purchases...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const purchases = data.data;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Plan</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Refunded</TableHead>
          <TableHead>Access</TableHead>
          <TableHead>Purchased</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {purchases.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-center text-muted-foreground">
              No purchases yet
            </TableCell>
          </TableRow>
        ) : (
          purchases.map((purchase) => {
            const access = accessLabel(purchase);
            return (
              <TableRow key={purchase.id}>
                <TableCell>{purchase.planId}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[purchase.status]}>{purchase.status}</Badge>
                </TableCell>
                <TableCell>{formatAmount(purchase.amountTotal, purchase.currency)}</TableCell>
                <TableCell>
                  {purchase.amountRefunded > 0
                    ? formatAmount(purchase.amountRefunded, purchase.currency)
                    : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={access.variant}>{access.text}</Badge>
                </TableCell>
                <TableCell>{new Date(purchase.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
