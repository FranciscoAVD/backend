"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationFn: () => authClient.signIn.email({ email, password }),
    onSuccess: ({ error }) => {
      if (!error) router.push("/dashboard");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate();
  };

  const error = signIn.data?.error;

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && (
          <FieldError>
            {error.code === "EMAIL_NOT_VERIFIED"
              ? "Check your email to verify your account before signing in."
              : error.message ?? "Something went wrong. Try again."}
          </FieldError>
        )}
        <Button type="submit" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in..." : "Sign in"}
        </Button>
      </FieldGroup>
    </form>
  );
}
