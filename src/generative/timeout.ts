/**
 * Timeout and cancellation helpers for provider control-plane calls.
 *
 * Provider implementations may wrap a native/IPC promise that cannot be
 * forcefully cancelled from JavaScript. The race still gives KYX a bounded
 * UI/runtime decision; late completion is ignored by the runtime epoch guard.
 */

export const GENERATIVE_PROVIDER_TIMEOUT_MS = 15_000;

export class GenerativeProviderTimeoutError extends Error {
  readonly code = "provider-timeout" as const;

  constructor(operation: string, timeoutMs: number) {
    super(`Generative provider ${operation} timed out after ${timeoutMs} ms`);
    this.name = "GenerativeProviderTimeoutError";
  }
}

export class GenerativeProviderAbortError extends Error {
  readonly code = "provider-aborted" as const;

  constructor(operation: string) {
    super(`Generative provider ${operation} was aborted`);
    this.name = "GenerativeProviderAbortError";
  }
}

export interface GenerativeTimeoutOptions {
  operation: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function safeTimeoutMs(value: number | undefined): number {
  if (value === undefined) return GENERATIVE_PROVIDER_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Provider timeout must be positive");
  return Math.max(1, Math.floor(value));
}

/** Resolve a provider operation only while its bounded control budget remains. */
export function withGenerativeTimeout<T>(promise: Promise<T>, options: GenerativeTimeoutOptions): Promise<T> {
  const timeoutMs = safeTimeoutMs(options.timeoutMs);
  if (options.signal?.aborted) return Promise.reject(new GenerativeProviderAbortError(options.operation));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new GenerativeProviderAbortError(options.operation)));
    const timer = setTimeout(
      () => finish(() => reject(new GenerativeProviderTimeoutError(options.operation, timeoutMs))),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
