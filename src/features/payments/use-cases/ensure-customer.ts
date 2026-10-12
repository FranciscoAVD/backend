import { db } from "@d/connection";
import { user as userTable } from "@d/schemas/auth-schema";
import { getPaymentProcessor } from "@f/payments/payment";
import { eq } from "drizzle-orm";

type Customer = {
  id: string;
  name: string;
  email: string;
  stripeCustomerId: string | null;
};

/**
 * @description Returns the user's Stripe customer id, creating one first if `createCustomerOnSignUp`'s
 * sign-up hook never succeeded (e.g. Stripe was unreachable at sign-up time). Mirrors the metadata
 * shape the stripe plugin itself sets, so a customer created here looks the same either way.
 * Assumes validation. Operation must be wrapped in try-catch
 * @param user object of id, name, email and the user's current (possibly null) Stripe customer id
 * @returns The existing or newly created Stripe customer id.
 */
export async function ensureStripeCustomer(user: Customer): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await getPaymentProcessor().customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id, customerType: "user" },
  });

  await db
    .update(userTable)
    .set({ stripeCustomerId: customer.id })
    .where(eq(userTable.id, user.id));

  return customer.id;
}
