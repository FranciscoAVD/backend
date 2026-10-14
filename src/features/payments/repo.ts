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
  getAllPurchasesAdmin,
  getPurchasesByUserAdmin,
  getPurchaseBySession,
  getPurchaseBySessionAnyUser,
  getBlockingPurchaseByPlan,
  hasAnyBlockingPurchase,
  hasActivePurchase,
} from "@f/payments/use-cases/get-purchases";
import {
  hasActiveSubscription,
  getReconcilableSubscriptions,
  getSubscriptionsByIds,
} from "@f/payments/use-cases/get-subscription";
import { updateSubscriptionFields } from "@f/payments/use-cases/update-subscription";
import {
  createCheckout,
  expireCheckout,
  isUserDeleting,
  getCheckoutStatus,
  getPendingCheckout,
  getResumableCheckout,
  reservePendingCheckout,
  releaseReservation,
  acquireCreateLock,
  releaseCreateLock,
  markProcessing,
  markFailed,
  markExpired,
  removePendingCheckout,
} from "@f/payments/use-cases/checkout";
import { syncPlanPricesActive } from "@f/payments/use-cases/sync-plan-prices";
import { syncPurchaseCharge } from "@f/payments/use-cases/sync-purchase-charge";
import { expireOpenCheckoutsForPlan } from "@f/payments/use-cases/expire-plan-checkouts";
import { ensureStripeCustomer } from "@f/payments/use-cases/ensure-customer";
import { addAuditLog } from "@f/payments/use-cases/add-audit-log";
import { getActivePlans } from "@f/payments/use-cases/get-active-plans";
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
    syncPricesActive: syncPlanPricesActive,
    expireOpenCheckouts: expireOpenCheckoutsForPlan,
  },
  purchase: {
    add: addPurchase,
    getAll: getAllPurchases,
    getAllAdmin: getAllPurchasesAdmin,
    getByUserAdmin: getPurchasesByUserAdmin,
    getBySession: getPurchaseBySession,
    getBySessionAnyUser: getPurchaseBySessionAnyUser,
    getBlockingByPlan: getBlockingPurchaseByPlan,
    hasAnyBlocking: hasAnyBlockingPurchase,
    hasActive: hasActivePurchase,
    syncCharge: syncPurchaseCharge,
  },
  subscription: {
    hasActive: hasActiveSubscription,
    getReconcilable: getReconcilableSubscriptions,
    getByIds: getSubscriptionsByIds,
    updateFields: updateSubscriptionFields,
  },
  checkout: {
    create: createCheckout,
    expire: expireCheckout,
    isUserDeleting,
    getStatus: getCheckoutStatus,
    getPending: getPendingCheckout,
    getResumable: getResumableCheckout,
    reserve: reservePendingCheckout,
    releaseReservation,
    acquireCreateLock,
    releaseCreateLock,
    markProcessing,
    markFailed,
    markExpired,
    removePending: removePendingCheckout,
  },
  access: {
    getActivePlans,
  },
  audit: {
    add: addAuditLog,
    getByUser: getAuditLogByUser,
    getAll: getAllAuditLog,
  },
};
