export const logger = {
  error: (scope: string, error: Error, meta?: Record<string, unknown>) => {
    console.error(
      `[${new Date().toISOString()}] ${scope}:`,
      error.message,
      meta ?? "",
    );
  },
};
