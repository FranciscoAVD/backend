import { addPlan } from "@f/payments/use-cases/add-plan";
import {
  getPlan,
  getPlanByName,
  getPlans,
  getSubscriptionPlans,
} from "@f/payments/use-cases/get-plans";
import { updatePlan } from "@f/payments/use-cases/update-plan";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import {
  getAllPurchases,
  getPurchaseBySession,
  getBlockingPurchaseByPlan,
  hasActivePurchase,
} from "@f/payments/use-cases/get-purchases";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import {
  createCheckout,
  getCheckoutStatus,
  hasPendingCheckout,
  getPendingCheckout,
  markProcessing,
  markFailed,
  markExpired,
  removePendingCheckout,
} from "@f/payments/use-cases/checkout";
import { ensureStripeCustomer } from "@f/payments/use-cases/ensure-customer";
import { addAuditLog } from "@f/payments/use-cases/add-audit-log";
import {
  getAuditLogByUser,
  getAllAuditLog,
} from "@f/payments/use-cases/get-audit-log";

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
    update: updatePlan,
  },
  purchase: {
    add: addPurchase,
    getAll: getAllPurchases,
    getBySession: getPurchaseBySession,
    getBlockingByPlan: getBlockingPurchaseByPlan,
    hasActive: hasActivePurchase,
    updateByPaymentIntent: updatePurchaseByPaymentIntent,
  },
  checkout: {
    create: createCheckout,
    getStatus: getCheckoutStatus,
    hasPending: hasPendingCheckout,
    getPending: getPendingCheckout,
    markProcessing,
    markFailed,
    markExpired,
    removePending: removePendingCheckout,
  },
  audit: {
    add: addAuditLog,
    getByUser: getAuditLogByUser,
    getAll: getAllAuditLog,
  },
};
