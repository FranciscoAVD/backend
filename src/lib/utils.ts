export async function tryCatch<T>(
  fn: Promise<T> | (() => Promise<T>),
): Promise<[T, null] | [null, Error]> {
  try {
    return [await (typeof fn === "function" ? fn() : fn), null];
  } catch (e) {
    return [null, e instanceof Error ? e : Error(String(e))];
  }
}
