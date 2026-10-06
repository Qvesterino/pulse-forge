/** Wait for boot-time sample-bank hydration without making the cancel button inert. */
export function awaitMasteringSampleBankReady(
  readiness: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Mastering cancelled during sample preparation", "AbortError"));
  if (!readiness) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Mastering cancelled during sample preparation", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    readiness.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
