import { APIError } from "better-auth/api";

/**
 * User fields only the server may set. `@better-auth/stripe` registers `stripeCustomerId` on the
 * user without `input: false`, so better-auth accepts it from the request body on sign-up and
 * `/update-user` like any other profile field. Left open, a user can point their account at any
 * Stripe customer: this app's checkout then charges through that customer, the plugin's billing
 * portal opens it (invoices, saved cards, subscription cancellation), the plugin's user-update hook
 * rewrites that customer's email, and deleting the account cancels that customer's subscriptions.
 *
 * Can't be fixed with `user.additionalFields.stripeCustomerId.input = false`: better-auth merges
 * plugin schemas over `additionalFields`, so the plugin's own definition wins.
 */
export const PROTECTED_USER_FIELDS = ["stripeCustomerId"] as const;

// every better-auth endpoint that copies user-supplied body fields onto the user row. The admin
// plugin's /admin/create-user and /admin/update-user also do, but they require admin rights
const takesUserInput = (path: string) =>
  path.startsWith("/sign-up/") || path === "/update-user";

/**
 * @description Rejects a sign-up or `/update-user` request that tries to set a protected field.
 * Rejected rather than silently stripped, so a client that sends one finds out. Run from
 * `paymentsBeforeHook` (`lib/auth-hooks.ts`).
 * @throws APIError (400) naming the field
 */
export function rejectProtectedUserFields(ctx: { path?: string; body?: unknown }): void {
  if (!ctx.path || !takesUserInput(ctx.path)) return;
  const body = ctx.body;
  if (typeof body !== "object" || body === null) return;
  for (const field of PROTECTED_USER_FIELDS)
    if (field in body)
      throw new APIError("BAD_REQUEST", {
        message: `${field} is not allowed to be set`,
        code: "FIELD_NOT_ALLOWED",
      });
}
