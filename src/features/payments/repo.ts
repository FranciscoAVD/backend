import { addPlan } from "@f/payments/use-cases/add-plan";
import {
  getPlan,
  getPlanByName,
  getPlans,
  getAllPlansIncludingInactive,
  getPlanByPriceId,
  getSubscriptionPlans,
} from "@f/payments/use-cases/get-plans";
import { updatePlan } from "@f/payments/use-cases/update-plan";
import { addPurchase } from "@f/payments/use-cases/add-purchase";
import {
  getAllPurchases,
  getPurchaseBySession,
  getPurchaseBySessionAnyUser,
  getBlockingPurchaseByPlan,
  hasAnyBlockingPurchase,
  hasActivePurchase,
} from "@f/payments/use-cases/get-purchases";
import { updatePurchaseByPaymentIntent } from "@f/payments/use-cases/update-purchase";
import {
  hasActiveSubscription,
  getReconcilableSubscriptions,
} from "@f/payments/use-cases/get-subscription";
import { updateSubscriptionFields } from "@f/payments/use-cases/update-subscription";
import {
  createCheckout,
  getCheckoutStatus,
  hasPendingCheckout,
  getPendingCheckout,
  reservePendingCheckout,
  releaseReservation,
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
    getAllIncludingInactive: getAllPlansIncludingInactive,
    getByPriceId: getPlanByPriceId,
    getSubscriptions: getSubscriptionPlans,
    update: updatePlan,
  },
  purchase: {
    add: addPurchase,
    getAll: getAllPurchases,
    getBySession: getPurchaseBySession,
    getBySessionAnyUser: getPurchaseBySessionAnyUser,
    getBlockingByPlan: getBlockingPurchaseByPlan,
    hasAnyBlocking: hasAnyBlockingPurchase,
    hasActive: hasActivePurchase,
    updateByPaymentIntent: updatePurchaseByPaymentIntent,
  },
  subscription: {
    hasActive: hasActiveSubscription,
    getReconcilable: getReconcilableSubscriptions,
    updateFields: updateSubscriptionFields,
  },
  checkout: {
    create: createCheckout,
    getStatus: getCheckoutStatus,
    hasPending: hasPendingCheckout,
    getPending: getPendingCheckout,
    reserve: reservePendingCheckout,
    releaseReservation,
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
