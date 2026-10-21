"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";

export function SignUpForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signUp = useMutation({
    mutationFn: () => authClient.signUp.email({ name, email, password }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signUp.mutate();
  };

  // The server never creates a session on sign-up here (emailAndPassword.requireEmailVerification
  // is on), and it returns a generic success-shaped response even for an already-registered email,
  // so an attacker can't use this form to find out which emails exist. There's no "redirect to
  // /dashboard" step for sign-up - the real success state is "go check your email."
  if (signUp.data && !signUp.data.error) {
    return (
      <p className="text-sm">
        Check your email to verify your account, then{" "}
        <a href="/sign-in" className="font-medium underline">
          sign in
        </a>
        .
      </p>
    );
  }

  const error = signUp.data?.error;

  return (
    <form onSubmit={onSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <FieldError>{error.message ?? "Something went wrong. Try again."}</FieldError>}
        <Button type="submit" disabled={signUp.isPending}>
          {signUp.isPending ? "Signing up..." : "Sign up"}
        </Button>
      </FieldGroup>
    </form>
  );
}
