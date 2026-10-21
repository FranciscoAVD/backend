import {
  start,
  status,
  expire,
  markProcessing,
  markFailed,
  markExpired,
  markCompleted,
} from "@backend/f/payments/services/checkout";
import { create, update, access } from "@backend/f/payments/services/plan";
import { confirm, syncCharge, refund } from "@backend/f/payments/services/fulfillment";
import {
  ensureCustomer,
  prepareDeletion,
  abortDeletion,
  guardSubscriptionUpgrade,
} from "@backend/f/payments/services/account";
import { purchases, subscriptions } from "@backend/f/payments/services/reconcile";

export const paymentsServices = {
  checkout: { start, status, expire, markProcessing, markFailed, markExpired, markCompleted },
  plan: { create, update, access },
  fulfillment: { confirm, syncCharge, refund },
  account: { ensureCustomer, prepareDeletion, abortDeletion, guardSubscriptionUpgrade },
  reconcile: { purchases, subscriptions },
};
