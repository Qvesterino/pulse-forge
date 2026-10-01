import { describe, it, expect } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import { createCollabServer } from "../server/collab-server.mjs";

/**
 * AGENT-MADE gallery provenance (MCP ťah #4) — the store accepts origin/
 * agent on publish, defaults everything else to human, and the feed returns
 * the fields untouched so the gallery UI can badge + filter on them.
 */

function validCode(): string {
  return compressToEncodedURIComponent(JSON.stringify({ tracks: [{ id: "t1", kind: "drum", name: "drums" }] }));
}

describe("gallery agent provenance", () => {
  it("origin:'agent' + agent name round-trip through add → list", () => {
    const { gallery } = createCollabServer();
    const result = gallery.add({
      title: "night drive",
      author: "KYX agent",
      code: validCode(),
      origin: "agent",
      agent: "Claude (MCP)",
      tags: ["agent-demo"],
    });
    expect(result.error).toBeUndefined();
    const listed = gallery.list().find((item: { id: string }) => item.id === result.item?.id);
    expect(listed?.origin).toBe("agent");
    expect(listed?.agent).toBe("Claude (MCP)");
  });

  it("human publish (no origin) → origin 'human', agent null", () => {
    const { gallery } = createCollabServer();
    const result = gallery.add({ title: "hand made", author: "qvester", code: validCode() });
    expect(result.error).toBeUndefined();
    const listed = gallery.list().find((item: { id: string }) => item.id === result.item?.id);
    expect(listed?.origin).toBe("human");
    expect(listed?.agent).toBeNull();
  });

  it("junk origin values never fake agent provenance", () => {
    const { gallery } = createCollabServer();
    const result = gallery.add({
      title: "sneaky",
      author: "anon",
      code: validCode(),
      origin: "AGENT",
      agent: "spoof",
    });
    expect(result.error).toBeUndefined();
    const listed = gallery.list().find((item: { id: string }) => item.id === result.item?.id);
    expect(listed?.origin).toBe("human");
    expect(listed?.agent).toBeNull();
  });

  it("agent publish without a name falls back to 'unknown agent'", () => {
    const { gallery } = createCollabServer();
    const result = gallery.add({
      title: "unnamed bot",
      author: "anon",
      code: validCode(),
      origin: "agent",
    });
    expect(result.error).toBeUndefined();
    const listed = gallery.list().find((item: { id: string }) => item.id === result.item?.id);
    expect(listed?.origin).toBe("agent");
    expect(listed?.agent).toBe("unknown agent");
  });
});
