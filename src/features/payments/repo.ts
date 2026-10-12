import { addPlan } from "@f/payments/use-cases/add-plan";
import {
  getPlan,
  getPlanByName,
  getPlans,
  getSubscriptionPlans,
} from "@f/payments/use-cases/get-plans";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import {
  getAllPurchases,
  getPurchaseBySession,
  getPaidPurchaseByPlan,
  hasActivePurchase,
} from "@f/payments/use-cases/get-purchases";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import { createCheckout, getCheckoutStatus } from "@f/payments/use-cases/checkout";
import { ensureStripeCustomer } from "@f/payments/use-cases/ensure-customer";

export const paymentsRepo = {
  customer: {
    ensure: ensureStripeCustomer,
  },
  plan: {
    add: addPlan,
    get: getPlan,
    getByName: getPlanByName,
    getAll: getPlans,
    getSubscriptions: getSubscriptionPlans,
  },
  purchase: {
    add: addPurchase,
    getAll: getAllPurchases,
    getBySession: getPurchaseBySession,
    getPaidByPlan: getPaidPurchaseByPlan,
    hasActive: hasActivePurchase,
    updateByPaymentIntent: updatePurchaseByPaymentIntent,
  },
  checkout: {
    create: createCheckout,
    getStatus: getCheckoutStatus,
  },
};
