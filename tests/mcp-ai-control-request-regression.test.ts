import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { createDefaultProject } from "../src/project-model/schema";
import { applyIntent, previewIntent } from "./helpers/intentProtocol";

describe("AI control safety regression", () => {
  it("refuses pattern replacement while the destructive unlock is off", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const before = host.store.doc;

    const result = await host.call("kyx_generate", { genre: "house", replaceMode: "replace" });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("POLICY_REFUSED");
    expect(host.store.doc).toBe(before);
    expect(host.store.undoStackLength).toBe(0);
  });

  it("applies an unlocked pattern replacement in one undo step that restores the document", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject(), allowDestructive: true });
    const before = structuredClone(host.store.doc);

    const result = await host.call("kyx_generate", { genre: "techno", replaceMode: "replace" });

    expect(result.isError, result.text).not.toBe(true);
    expect(result.mutated).toBe(true);
    expect(host.store.undoStackLength).toBe(1);
    expect(host.store.doc).not.toEqual(before);

    host.store.undo();

    expect(host.store.doc).toEqual(before);
    expect(host.store.undoStackLength).toBe(0);
  });

  it("reports a repeated mute as a no-op without claiming an undo step", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });

    const first = await applyIntent(host, "mute the drums");
    expect(first.isError, first.text).not.toBe(true);
    expect(first.mutated).toBe(true);
    const depthAfterFirst = host.store.undoStackLength;

    // The repeat is reviewed: the plan says nothing would change, so there is
    // no planId to apply — and no undo step to claim.
    const second = await previewIntent(host, "mute the drums");

    expect(second.isError, second.text).not.toBe(true);
    expect(second.mutated).toBe(false);
    expect(second.data).toMatchObject({ status: "preview", mutates: false });
    expect(second.text).not.toContain("one undo step");
    expect(host.store.undoStackLength).toBe(depthAfterFirst);
  });
});
