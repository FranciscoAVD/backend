"use client";

import Link from "next/link";
import { ArrowRight, Shield, Sparkles, Zap } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const features = [
  {
    icon: Zap,
    title: "Fast by default",
    description:
      "Built on Bun and Hono RPC for end-to-end type safety with no extra ceremony.",
  },
  {
    icon: Shield,
    title: "Secure sessions",
    description:
      "Authentication and authorization handled by better-auth out of the box.",
  },
  {
    icon: Sparkles,
    title: "Ready to extend",
    description:
      "A clean feature-folder layout so your next resource slots right in.",
  },
];

export function LandingPage() {
  const { data: session, isPending } = authClient.useSession();

  return (
    <div className="flex flex-1 flex-col">
      <section className="flex flex-col items-center gap-6 px-6 py-24 text-center sm:py-32">
        <Badge variant="secondary">Now in development</Badge>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Ship your product, not your boilerplate
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          A monorepo starter with auth, payments, and an admin dashboard already
          wired up, so you can focus on what makes your product different.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          {!isPending && session ? (
            <Button
              size="lg"
              nativeButton={false}
              render={
                <Link href="/dashboard">
                  Go to dashboard
                  <ArrowRight />
                </Link>
              }
            />
          ) : (
            <>
              <Button
                size="lg"
                nativeButton={false}
                render={
                  <Link href="/sign-up">
                    Get started
                    <ArrowRight />
                  </Link>
                }
              />
              <Button
                size="lg"
                variant="outline"
                nativeButton={false}
                render={<Link href="/sign-in">Sign in</Link>}
              />
            </>
          )}
        </div>
      </section>

      <section className="border-t px-6 py-20">
        <div className="mx-auto grid max-w-5xl gap-6 sm:grid-cols-3">
          {features.map(({ icon: Icon, title, description }) => (
            <Card key={title}>
              <CardHeader>
                <Icon className="mb-2 size-5 text-muted-foreground" />
                <CardTitle>{title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>{description}</CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
