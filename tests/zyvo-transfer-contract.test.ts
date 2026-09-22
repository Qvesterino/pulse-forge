import { describe, expect, it } from "vitest";
import { ZYVO_TRANSFER_FORMAT, ZYVO_TRANSFER_VERSION, MAX_ZYVO_TRANSFER_BYTES } from "../src/export/zyvo-transfer";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { encodeUtf8 } from "../src/export/zyvo-transfer";

/**
 * GOAL 08 — zyvo-transfer (cross-app handoff to VocalForge) had ZERO test
 * coverage. The render itself needs Web Audio; the TRANSFER CONTRACT does
 * not: format identity, version, size ceilings, and the early caps that
 * guard the user's whole-song handoff before any rendering starts.
 */
describe("zyvo-transfer contract (GOAL 08)", () => {
  it("declares the cross-app format identity", () => {
    expect(ZYVO_TRANSFER_FORMAT).toBe("com.kyx.zyvo-transfer");
    expect(ZYVO_TRANSFER_VERSION).toBe(1);
  });

  it("caps: 1 GiB transfer ceiling constant stays at 1 GiB", () => {
    expect(MAX_ZYVO_TRANSFER_BYTES).toBe(1024 * 1024 * 1024);
  });

  it("embedded project JSON stays far below the 64 MiB embedded limit for stock templates", () => {
    const doc = createProjectFromTemplate("house");
    const bytes = Buffer.byteLength(JSON.stringify(doc, null, 2), "utf8");
    expect(bytes).toBeLessThan(64 * 1024 * 1024);
    expect(bytes).toBeGreaterThan(0);
  });

  it("encodeUtf8 produces byte-accurate UTF-8 (multi-byte names survive the handoff)", () => {
    const bytes = encodeUtf8("KYX prekvapenie ×42");
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0x4b, 0x59, 0x58]); // "KYX"
    expect(bytes.length).toBeGreaterThan("KYX prekvapenie 42".length); // multi-byte × present
  });
});
