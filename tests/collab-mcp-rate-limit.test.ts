import { describe, expect, it } from "vitest";
// The server is a .mjs module without type declarations; the runtime export
// is verified by node (tests/collab-mcp-rate-limit runs under vitest ESM).
// @ts-expect-error -- untyped .mjs module (server/collab-server.mjs)
import { makeRateLimiter } from "../server/collab-server.mjs";

/**
 * AS-010: the /mcp route paces at 30 calls per minute per client — the same
 * sustained budget the desktop bridge's token bucket enforces. The limiter
 * is the shared sliding-window helper, imported here directly so the gate
 * is pinned without spawning the server.
 */
describe("collab-server /mcp rate limit (AS-010)", () => {
  it("allows the first 30 calls in the window and refuses the 31st", () => {
    const allow = makeRateLimiter(30);
    for (let index = 0; index < 30; index += 1) {
      expect(allow("203.0.113.7"), `call ${index + 1}`).toBe(true);
    }
    expect(allow("203.0.113.7")).toBe(false);
  });

  it("tracks clients independently", () => {
    const allow = makeRateLimiter(2);
    expect(allow("198.51.100.1")).toBe(true);
    expect(allow("198.51.100.1")).toBe(true);
    expect(allow("198.51.100.1")).toBe(false);
    expect(allow("198.51.100.2")).toBe(true);
  });

  it("re-admits after the window slides", () => {
    const allow = makeRateLimiter(1);
    expect(allow("192.0.2.9")).toBe(true);
    expect(allow("192.0.2.9")).toBe(false);
    // Fake the window having elapsed by injecting an old timestamp.
    const now = Date.now() + 61_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      expect(allow("192.0.2.9")).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});
