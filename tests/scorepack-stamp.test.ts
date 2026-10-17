import { describe, expect, it, vi } from "vitest";
import { buildScorepack } from "../src/export/scorepack";
import { STEM_GROUPS } from "../src/rendering/stems";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { SampleBank } from "../src/sample-library/factory";

/**
 * WAVE 2/C — scorepack stamping. The ZIP encoder is STORE-only, so the iXML
 * markers are searched directly in the packaged bytes: that is the real
 * artifact, not a helper.
 */

vi.mock("../src/rendering/renderer", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/rendering/renderer")>();
  return {
    ...mod,
    renderProject: vi.fn(async () => ({
      numberOfChannels: 2,
      length: 48000,
      sampleRate: 48000,
      duration: 1,
      getChannelData: (channel: number) => new Float32Array(48000).fill(0.1 + channel * 0.01),
    })),
  };
});

describe("scorepack provenance stamping", () => {
  it("stamps the master and every stem WAV with an iXML manifest", async () => {
    const doc = createProjectFromTemplate("house");
    const bank = { get: () => undefined } as unknown as SampleBank;
    const { blob, filename } = await buildScorepack(doc, bank, () => {}, undefined, {
      quality: "studio",
      assets: [],
    });
    const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
    // One manifest per audio entry: the master plus each stem group.
    const markers = text.match(/<KYX>/g) ?? [];
    expect(markers).toHaveLength(1 + STEM_GROUPS.length);
    expect(text).toContain("kyx-render-manifest/1");
    expect(text).toContain("scope&quot;:&quot;master");
    expect(text).toContain("scope&quot;:&quot;stems");
    expect(filename.endsWith(".scorepack")).toBe(true);
  });
});
