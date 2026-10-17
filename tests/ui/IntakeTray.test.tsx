import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { IntakeTray } from "../../src/ui/IntakeTray";
import { renderWithContext } from "../helpers";

/**
 * SEND-TO-KYX intake tray — duplicate-import recovery. The DELETE that retires
 * a consumed item is best-effort: when it fails, the 8 s poll re-lists the item.
 * Without the session-side dedupe a second click imports the same audio again
 * under a fresh id (a duplicate sample, not an overwrite).
 */

describe("IntakeTray duplicate-import recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never re-offers an item whose delete failed (session dedupe)", async () => {
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler: Parameters<typeof setInterval>[0]) => {
      intervalCallbacks.push(handler as () => void);
      return 1 as unknown as ReturnType<typeof setInterval>;
    });

    const item = { id: "i1", name: "beat.wav", sourceUrl: null, bytes: 8, createdAt: new Date().toISOString() };
    const payload = btoa("hello");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/intake/i1") && init?.method === "DELETE") {
        // The retire write fails — the item stays on the server.
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
      }
      if (url.endsWith("/api/intake/i1")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ item: { name: "beat.wav", dataB64: payload } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [item] }) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    renderWithContext(<IntakeTray onImported={onImported} />);

    // The tray lists the item; import it.
    const importButton = await screen.findByRole("button", { name: "→ SAMPLE" });
    fireEvent.click(importButton);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));

    // The server still lists it (DELETE failed) — but the poll must NOT bring
    // it back for a second import.
    expect(intervalCallbacks.length).toBeGreaterThan(0);
    for (const callback of intervalCallbacks) callback();
    await waitFor(() => expect(screen.queryByRole("button", { name: "→ SAMPLE" })).toBeNull());
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});
