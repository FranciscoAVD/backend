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
  getAllPurchasesWithAccess,
  getAllPurchasesAdmin,
  getPurchasesByUserAdmin,
  getPurchaseById,
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
import { syncPurchaseCharge } from "@f/payments/use-cases/sync-purchase-charge";
import { addAuditLog } from "@f/payments/use-cases/add-audit-log";
import { getActivePlans } from "@f/payments/use-cases/get-active-plans";
import {
  getAuditLogByUser,
  getAllAuditLog,
} from "@f/payments/use-cases/get-audit-log";
import {
  getEmailVerified,
  getForCustomer,
  getContact,
  setStripeCustomerId,
} from "@f/payments/use-cases/user";

export const paymentsRepo = {
  plan: {
    add: addPlan,
    get: {
      one: getPlan,
      byName: getPlanByName,
      byPriceId: getPlanByPriceId,
      active: getPlans,
      all: getAllPlansIncludingInactive,
      subscriptions: getSubscriptionPlans,
    },
    update: updatePlan,
  },
  purchase: {
    add: addPurchase,
    get: {
      mine: getAllPurchases,
      mineWithAccess: getAllPurchasesWithAccess,
      byId: getPurchaseById,
      bySession: getPurchaseBySession,
      bySessionAnyUser: getPurchaseBySessionAnyUser,
      allAdmin: getAllPurchasesAdmin,
      byUserAdmin: getPurchasesByUserAdmin,
    },
    getBlocking: getBlockingPurchaseByPlan,
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
  user: {
    getEmailVerified,
    getForCustomer,
    getContact,
    setStripeCustomerId,
  },
  access: {
    activePlans: getActivePlans,
  },
  audit: {
    add: addAuditLog,
    get: {
      all: getAllAuditLog,
      byUser: getAuditLogByUser,
    },
  },
};
