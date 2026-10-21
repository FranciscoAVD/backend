"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function DashboardPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) router.replace("/sign-in");
  }, [isPending, session, router]);

  if (isPending || !session) return null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p>Signed in as {session.user.email}</p>
      <button
        type="button"
        onClick={() => authClient.signOut({ fetchOptions: { onSuccess: () => router.push("/sign-in") } })}
        className="rounded border border-black/[.08] px-4 py-2 font-medium dark:border-white/[.145]"
      >
        Sign out
      </button>
    </div>
  );
}
