import { start, status, expire, markProcessing, markFailed, markExpired } from "@f/payments/services/checkout";
import { create, update, access } from "@f/payments/services/plan";
import { confirm, syncCharge } from "@f/payments/services/fulfillment";
import {
  ensureCustomer,
  prepareDeletion,
  abortDeletion,
  guardSubscriptionUpgrade,
} from "@f/payments/services/account";
import { purchases, subscriptions } from "@f/payments/services/reconcile";

export const paymentsServices = {
  checkout: { start, status, expire, markProcessing, markFailed, markExpired },
  plan: { create, update, access },
  fulfillment: { confirm, syncCharge },
  account: { ensureCustomer, prepareDeletion, abortDeletion, guardSubscriptionUpgrade },
  reconcile: { purchases, subscriptions },
};
