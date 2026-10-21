import { addPlan } from "@backend/f/payments/use-cases/add-plan";
import {
  getPlan,
  getPlanByName,
  getPlans,
  getAllPlansIncludingInactive,
  getPlanByPriceId,
  getSubscriptionPlans,
} from "@backend/f/payments/use-cases/get-plans";
import { updatePlan } from "@backend/f/payments/use-cases/update-plan";
import { addPurchase } from "@backend/f/payments/use-cases/add-purchase";
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
} from "@backend/f/payments/use-cases/get-purchases";
import { claimCheckoutSlot } from "@backend/f/payments/use-cases/claim-checkout";
import {
  getCheckoutBySession,
  getResumableCheckout,
  getProcessingCheckouts,
} from "@backend/f/payments/use-cases/get-checkouts";
import {
  openCheckout,
  transitionCheckout,
  releaseCheckoutReservation,
} from "@backend/f/payments/use-cases/update-checkout";
import {
  hasActiveSubscription,
  getReconcilableSubscriptions,
  getSubscriptionsByIds,
} from "@backend/f/payments/use-cases/get-subscription";
import { updateSubscriptionFields } from "@backend/f/payments/use-cases/update-subscription";
import { syncPurchaseCharge } from "@backend/f/payments/use-cases/sync-purchase-charge";
import { addAuditLog } from "@backend/f/payments/use-cases/add-audit-log";
import { getActivePlans } from "@backend/f/payments/use-cases/get-active-plans";
import {
  getAuditLogByUser,
  getAllAuditLog,
} from "@backend/f/payments/use-cases/get-audit-log";
import {
  getEmailVerified,
  getForCustomer,
  getContact,
  getAdminContacts,
  setStripeCustomerId,
} from "@backend/f/payments/use-cases/user";

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
  checkout: {
    claim: claimCheckoutSlot,
    get: {
      bySession: getCheckoutBySession,
      resumable: getResumableCheckout,
      processing: getProcessingCheckouts,
    },
    open: openCheckout,
    transition: transitionCheckout,
    release: releaseCheckoutReservation,
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
    getAdminContacts,
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
