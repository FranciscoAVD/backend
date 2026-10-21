import {
  insertPlanSchema,
  updatePlanSchema,
  selectPlanSchema,
  insertPurchaseSchema,
  updatePurchaseSchema,
  selectPurchaseSchema,
  insertCheckoutSchema,
  updateCheckoutSchema,
  selectCheckoutSchema,
  insertPaymentAuditLogSchema,
  selectPaymentAuditLogSchema,
} from "@backend/f/payments/lib/schemas";
import { z } from "zod";

export namespace Payment {
  export namespace Plan {
    export type Insert = z.infer<typeof insertPlanSchema>;
    export type Update = z.infer<typeof updatePlanSchema>;
  }
  export type Plan = z.infer<typeof selectPlanSchema>;

  export namespace Purchase {
    export type Insert = z.infer<typeof insertPurchaseSchema>;
    export type Update = z.infer<typeof updatePurchaseSchema>;
  }
  export type Purchase = z.infer<typeof selectPurchaseSchema>;

  export namespace Checkout {
    export type Insert = z.infer<typeof insertCheckoutSchema>;
    export type Update = z.infer<typeof updateCheckoutSchema>;
  }
  export type Checkout = z.infer<typeof selectCheckoutSchema>;

  export namespace AuditLog {
    export type Insert = z.infer<typeof insertPaymentAuditLogSchema>;
  }
  export type AuditLog = z.infer<typeof selectPaymentAuditLogSchema>;
}
