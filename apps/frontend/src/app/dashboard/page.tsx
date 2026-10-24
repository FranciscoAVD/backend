"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { PlansView } from "@/features/payments/plans-view";

export default function DashboardPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) router.replace("/sign-in");
  }, [isPending, session, router]);

  if (isPending || !session) return null;

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Signed in as {session.user.email}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            authClient.signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })
          }
        >
          Sign out
        </Button>
      </div>
      <div>
        <h2 className="mb-4 text-lg font-medium">Plans</h2>
        <PlansView />
      </div>
    </div>
  );
}
