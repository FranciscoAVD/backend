import { Resend } from "resend";
import { env } from "@backend/env";

let client: Resend | undefined;

export function getEmailClient(): Resend {
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}
