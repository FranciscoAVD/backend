import {
  insertPlanSchema,
  selectPlanSchema,
  insertPurchaseSchema,
  updatePurchaseSchema,
  selectPurchaseSchema,
} from "@f/payments/lib/schemas";
import { z } from "zod";

export namespace Payment {
  export namespace Plan {
    export type Insert = z.infer<typeof insertPlanSchema>;
  }
  export type Plan = z.infer<typeof selectPlanSchema>;

  export namespace Purchase {
    export type Insert = z.infer<typeof insertPurchaseSchema>;
    export type Update = z.infer<typeof updatePurchaseSchema>;
  }
  export type Purchase = z.infer<typeof selectPurchaseSchema>;
}
