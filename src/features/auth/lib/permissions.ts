import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  userAc,
  adminAc,
} from "better-auth/plugins/admin/access";

export const statement = {
  ...defaultStatements,
  todo: ["create", "update", "delete"],
  plan: ["create", "update"],
} as const;

export const ac = createAccessControl(statement);

export const user = ac.newRole({
  todo: ["create", "update", "delete"],
  ...userAc.statements,
});
export const admin = ac.newRole({
  todo: ["create", "update", "delete"],
  plan: ["create", "update"],
  ...adminAc.statements,
});
