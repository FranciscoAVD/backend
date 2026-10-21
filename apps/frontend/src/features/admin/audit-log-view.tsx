"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
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

async function fetchAuditLogPage(before?: number) {
  const res = await apiClient.api.payments["audit-log"].$get({
    query: { limit: String(PAGE_SIZE), ...(before !== undefined ? { before } : {}) },
  });

  if (!res.ok) {
    const body = await res.json();
    throw new Error("message" in body ? body.message : "Failed to load audit log");
  }

  return res.json();
}

export function AuditLogView() {
  const { data, error, isPending, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useInfiniteQuery({
      queryKey: ["admin", "audit-log"],
      queryFn: ({ pageParam }) => fetchAuditLogPage(pageParam),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading audit log...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const rows = data.pages.flatMap((page) => page.data);

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Checkout session</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No audit entries
              </TableCell>
            </TableRow>
          ) : (
            rows.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-medium">{entry.type}</TableCell>
                <TableCell>{entry.userId ?? "—"}</TableCell>
                <TableCell>{entry.planId ?? "—"}</TableCell>
                <TableCell>{entry.stripeCheckoutSessionId ?? "—"}</TableCell>
                <TableCell>{new Date(entry.createdAt).toLocaleString()}</TableCell>
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
