import {
  insertPlanSchema,
  updatePlanSchema,
  selectPlanSchema,
  insertPurchaseSchema,
  updatePurchaseSchema,
  selectPurchaseSchema,
  insertPaymentAuditLogSchema,
  selectPaymentAuditLogSchema,
} from "@f/payments/lib/schemas";
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

  export namespace AuditLog {
    export type Insert = z.infer<typeof insertPaymentAuditLogSchema>;
  }
  export type AuditLog = z.infer<typeof selectPaymentAuditLogSchema>;
}
