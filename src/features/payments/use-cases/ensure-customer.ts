import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { getPaymentProcessor } from "@f/payments/payment";
import { eq } from "drizzle-orm";

type Customer = { id: string; name: string; email: string };

/**
 * @description Returns the user's Stripe customer id, creating one first if `createCustomerOnSignUp`'s
 * sign-up hook never succeeded (e.g. Stripe was unreachable at sign-up time). Always re-reads the
 * live `user` row itself rather than trusting a caller-supplied value - better-auth can serve a
 * Redis-cached `user` object without querying Postgres. A deterministic idempotency key protects a
 * retried call (e.g. after a timeout) from creating a second customer; it does not fully close two
 * truly simultaneous requests racing each other, which Stripe's idempotency semantics don't strictly
 * guarantee to dedupe - acceptable for now given how narrow that window is. Mirrors the metadata
 * shape the stripe plugin itself sets, so a customer created here looks the same either way.
 *
 * The new id is written through better-auth's own `internalAdapter.updateUser`, not a raw query,
 * because that also refreshes the user's cached sessions. The stripe plugin's subscription flow
 * reads `stripeCustomerId` from the session: written behind its back, the session kept serving
 * `null`, and the plugin then created a second customer and switched the user over to it, splitting
 * their payment history across two Stripe customers. Assumes validation. Operation must be wrapped
 * in try-catch
 * @param user object of id, name and email
 * @returns The existing or newly created Stripe customer id.
 */
export async function ensureStripeCustomer(user: Customer): Promise<string> {
  const [row] = await db
    .select({ stripeCustomerId: userTable.stripeCustomerId })
    .from(userTable)
    .where(eq(userTable.id, user.id));
  if (row?.stripeCustomerId) return row.stripeCustomerId;

  const customer = await getPaymentProcessor().customers.create(
    {
      email: user.email,
      name: user.name,
      metadata: { userId: user.id, customerType: "user" },
    },
    { idempotencyKey: `customer-${user.id}` },
  );

  // imported here, not at the top: auth.ts itself imports this feature's repo
  const { auth } = await import("@f/auth/auth");
  await (await auth.$context).internalAdapter.updateUser(user.id, {
    stripeCustomerId: customer.id,
  });

  return customer.id;
}
