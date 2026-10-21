"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
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

export function UsersView() {
  const [offset, setOffset] = useState(0);

  const { data, error, isPending } = useQuery({
    queryKey: ["admin", "users", offset],
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({
        query: { limit: PAGE_SIZE, offset, sortBy: "createdAt", sortDirection: "desc" },
      });
      if (error) throw new Error(error.message ?? "Failed to load users");
      return data;
    },
  });

  if (isPending) return <p className="text-sm text-muted-foreground">Loading users...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  const { users, total } = data;

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No users
              </TableCell>
            </TableRow>
          ) : (
            users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>{user.role ?? "user"}</TableCell>
                <TableCell>
                  {user.banned ? (
                    <Badge variant="destructive">Banned</Badge>
                  ) : user.emailVerified ? (
                    <Badge variant="secondary">Verified</Badge>
                  ) : (
                    <Badge variant="outline">Unverified</Badge>
                  )}
                </TableCell>
                <TableCell>{new Date(user.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total === 0 ? "0 users" : `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
