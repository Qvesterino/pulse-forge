import { describe, expect, it } from "vitest";
import { GenerativeProviderAbortError, GenerativeProviderTimeoutError, withGenerativeTimeout } from "../src/generative";

describe("generative provider timeout policy", () => {
  it("passes through a completed provider operation", async () => {
    await expect(
      withGenerativeTimeout(Promise.resolve("ready"), { operation: "handshake", timeoutMs: 50 }),
    ).resolves.toBe("ready");
  });

  it("bounds a provider operation that never settles", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withGenerativeTimeout(never, { operation: "capture", timeoutMs: 5 })).rejects.toMatchObject({
      code: "provider-timeout",
    });
    await expect(withGenerativeTimeout(never, { operation: "capture", timeoutMs: 5 })).rejects.toBeInstanceOf(
      GenerativeProviderTimeoutError,
    );
  });

  it("aborts before or during a provider operation", async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      withGenerativeTimeout(Promise.resolve("late"), { operation: "connect", signal: before.signal }),
    ).rejects.toBeInstanceOf(GenerativeProviderAbortError);

    const during = new AbortController();
    const pending = withGenerativeTimeout(new Promise<never>(() => undefined), {
      operation: "start",
      timeoutMs: 100,
      signal: during.signal,
    });
    during.abort();
    await expect(pending).rejects.toMatchObject({ code: "provider-aborted" });
  });
});
