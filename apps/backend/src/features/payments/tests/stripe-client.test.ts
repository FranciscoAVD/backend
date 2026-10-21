import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import { wrapForAuthPlugin } from "@backend/f/payments/lib/stripe/client";

// Tests the wrapping logic as a pure function of a plain fake client, not through
// getPaymentProcessor()'s real singleton: @backend/f/payments/lib/stripe/client is mocked by several
// other payments test files, and this file needing the real, unmocked module while those mock it
// is exactly the "per-file mocks don't leak, except when one file needs the real module and
// another mocks it" hazard CLAUDE.md's testing section documents - sidestepped entirely by never
// importing the real getPaymentProcessor() here.
function fakeClient(retrieve: (id?: string) => unknown) {
  const customers = {};
  const refunds = {};
  const subscriptions = { retrieve };
  return { customers, refunds, subscriptions } as unknown as Stripe;
}

describe("wrapForAuthPlugin", () => {
  test("subscriptions.retrieve with no id resolves to a safe dummy without calling through", async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls++;
      return { id: "should_not_be_returned" };
    });

    const wrapped = wrapForAuthPlugin(client);
    const result = await wrapped.subscriptions.retrieve(undefined as unknown as string);

    expect(calls).toBe(0);
    expect(result).toMatchObject({ id: "one_time_payment_no_subscription", items: { data: [] } });
  });

  test("subscriptions.retrieve with a real id delegates to the real client", async () => {
    const calls: (string | undefined)[] = [];
    const sentinel = { id: "sub_real" } as unknown as Stripe.Response<Stripe.Subscription>;
    const client = fakeClient((id) => {
      calls.push(id);
      return sentinel;
    });

    const wrapped = wrapForAuthPlugin(client);
    const result = await wrapped.subscriptions.retrieve("sub_real");

    expect(calls).toEqual(["sub_real"]);
    expect(result).toBe(sentinel);
  });

  test("every other method passes through to the real client untouched", () => {
    const client = fakeClient(() => null);
    const wrapped = wrapForAuthPlugin(client);

    expect(wrapped.customers).toBe(client.customers);
    expect(wrapped.refunds).toBe(client.refunds);
  });
});
