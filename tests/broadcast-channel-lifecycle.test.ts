import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BroadcastChannelProvider } from "../src/collab/BroadcastChannelProvider";

describe("BroadcastChannelProvider lifecycle", () => {
  it("reconnect does not stack yDoc update handlers (one edit → one broadcast)", () => {
    const yDoc = new Y.Doc();
    const postSpy = vi.spyOn(BroadcastChannel.prototype, "postMessage").mockImplementation(() => {});
    const provider = new BroadcastChannelProvider(yDoc, "lifecycle-room");
    provider.connect();
    provider.disconnect();
    provider.connect(); // open → close → reopen

    yDoc.transact(() => {
      yDoc.getMap("project").set("probe", 1);
    });

    const updates = postSpy.mock.calls.filter(([msg]) => (msg as { type?: string })?.type === "update");
    // Before the fix the stale handler from the first connect survived
    // disconnect() and every local edit broadcast twice.
    expect(updates.length).toBe(1);
    postSpy.mockRestore();
  });

  it("local edits after disconnect are silently dropped (no channel)", () => {
    const yDoc = new Y.Doc();
    const provider = new BroadcastChannelProvider(yDoc, "lifecycle-room-2");
    provider.connect();
    provider.disconnect();
    expect(() => {
      yDoc.getMap("project").set("probe", 2);
    }).not.toThrow();
  });
});
