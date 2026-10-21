export type { AppType } from "./index";
export type { Todo } from "./features/todo/lib/types";

// Real (not type-only) exports - safe because this module is pure
// access-control configuration (no secrets, DB, or other I/O). better-auth's
// adminClient plugin needs the actual values at runtime to match this
// server's real roles/permissions instead of silently falling back to
// better-auth's defaults.
export { ac, user, admin } from "./features/auth/lib/permissions";
