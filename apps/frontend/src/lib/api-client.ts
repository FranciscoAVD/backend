import { hc } from "hono/client";
import type { AppType } from "@app/backend";

// AppType is apiApp's type (basePath("/api")), so every route is nested one
// level under `.api` on the client (e.g. apiClient.api.todo.$get()).
export const apiClient = hc<AppType>(process.env.NEXT_PUBLIC_API_URL!, {
  init: { credentials: "include" },
});
