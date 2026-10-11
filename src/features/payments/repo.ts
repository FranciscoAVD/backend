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
} from "@f/payments/use-cases/get-purchases";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import { createCheckout, getCheckoutStatus } from "@f/payments/use-cases/checkout";

export const paymentsRepo = {
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
    updateByPaymentIntent: updatePurchaseByPaymentIntent,
  },
  checkout: {
    create: createCheckout,
    getStatus: getCheckoutStatus,
  },
};
