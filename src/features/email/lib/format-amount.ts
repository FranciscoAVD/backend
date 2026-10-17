/**
 * @description Formats a minor-units amount (e.g. cents) as a currency string, for email
 * content. Uses a fixed locale, not the runtime's default - this is an email's content, not a UI
 * rendered in the reader's own browser, so it must read the same regardless of which locale the
 * server runs under.
 * @param amountMinorUnits minor units (e.g. cents)
 * @param currency ISO currency code, case-insensitive
 */
export function formatAmount(amountMinorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinorUnits / 100);
}
