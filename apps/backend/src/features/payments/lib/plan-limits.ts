import { z } from "zod";

/**
 * The shape of a plan's `limits` - the one place to change it. The `plan.limits` column's type
 * (`db/schemas/payment-schema.ts`), the plan types (`Payment.Plan` and friends) and the admin
 * routes' validation all derive from this schema, so a type edit here is also enforced at
 * `POST /plans` and `PATCH /plans/:id` instead of only at compile time.
 *
 * The default accepts any JSON object. To make it yours, replace it with the keys your app gates
 * on, e.g.
 *
 *   z.object({ seats: z.number().int().positive(), exports: z.number().int().min(0) }).partial()
 *
 * Keep it an object: the stripe plugin also receives each subscription plan's limits
 * (`use-cases/get-plans.ts`), typed as `Record<string, unknown>`.
 *
 * Changing it doesn't re-check rows already stored - plans saved under the old shape keep it until
 * they're edited again, so update those (or make the new keys optional) when you change it.
 */
export const planLimitsSchema = z.record(z.string(), z.unknown());

export type PlanLimits = z.infer<typeof planLimitsSchema>;
