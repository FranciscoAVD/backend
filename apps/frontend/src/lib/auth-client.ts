import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { stripeClient } from "@better-auth/stripe/client";
import { ac, user, admin } from "@app/backend";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  fetchOptions: { credentials: "include" },
  plugins: [adminClient({ ac, roles: { user, admin } }), stripeClient({ subscription: true })],
});
