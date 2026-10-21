"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
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

const PAGE_SIZE = 50;

const STATUS_VARIANT = {
  paid: "default",
  refunded: "secondary",
  disputed: "destructive",
} as const;

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 100);
}

async function fetchPurchasesPage(before?: number) {
  const res = await apiClient.api.payments.purchases.all.$get({
    query: { limit: String(PAGE_SIZE), ...(before !== undefined ? { before } : {}) },
  });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to load purchases");
  }

  return res.json();
}

export function PurchasesView() {
  const { data, error, isPending, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useInfiniteQuery({
      queryKey: ["admin", "purchases"],
      queryFn: ({ pageParam }) => fetchPurchasesPage(pageParam),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading purchases...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const rows = data.pages.flatMap((page) => page.data);

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Refunded</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                No purchases
              </TableCell>
            </TableRow>
          ) : (
            rows.map((purchase) => (
              <TableRow key={purchase.id}>
                <TableCell>{purchase.userId ?? "—"}</TableCell>
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
                <TableCell>{new Date(purchase.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={isFetchingNextPage}
          onClick={() => fetchNextPage()}
          className="self-center"
        >
          {isFetchingNextPage ? "Loading..." : "Load more"}
        </Button>
      )}
    </div>
  );
}
