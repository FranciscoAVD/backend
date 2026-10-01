import type { StatusCode } from "hono/utils/http-status";

/**
 * @description Named HTTP status codes. Hono only ships status code types, not named values.
 * `as const` keeps each code a literal type, so `c.json(body, HTTP_STATUS.NOT_FOUND)` still
 * type-checks against Hono's status unions and keeps typed RPC responses intact.
 */
export const HTTP_STATUS = {
  SUCCESS: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
} as const satisfies Record<string, StatusCode>;
