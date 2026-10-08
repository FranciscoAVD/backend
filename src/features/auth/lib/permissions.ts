import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  userAc,
  adminAc,
} from "better-auth/plugins/admin/access";

const statement = {
  ...defaultStatements,
  todo: ["create", "update", "delete"],
  plan: ["create"],
} as const;

export const ac = createAccessControl(statement);

export const user = ac.newRole({
  todo: ["create", "update"],
  ...userAc.statements,
});
export const admin = ac.newRole({
  todo: ["create", "update", "delete"],
  plan: ["create"],
  ...adminAc.statements,
});
