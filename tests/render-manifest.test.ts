import { describe, expect, it } from "vitest";
import {
  KYX_MANIFEST_FORMAT,
  MANIFEST_MAX_ASSETS,
  buildRenderManifest,
  clearRenderStampForTests,
  collectAiAssetReceipts,
  collectAiPatternReceipts,
  collectAiTrackReceipts,
  formatManifestSummary,
  hashPcmChannels,
  lastRenderStamp,
  manifestFromIxml,
  manifestToIxml,
  parseRenderManifestFromWav,
  rememberRenderStamp,
  reproductionSettings,
  sha256Hex,
  verifyRenderManifest,
  type RenderManifest,
} from "../src/export/renderManifest";
import { createBextMetadata, encodeWav } from "../src/rendering/wav";
import { createDefaultProject } from "../src/project-model/schema";
import type { UserSampleAsset } from "../src/persistence/UserSampleRepository";

/**
 * WAVE 2/C — PROVENANCE-STAMPED EXPORTS.
 *
 * The manifest is what makes an exported WAV answerable: which project it
 * came from, whether a re-render is bit-identical, and which AI models are in
 * the mix. These specs pin the round-trip (encode → parse), the honest
 * degradations (no WebCrypto → null hash, never a fabricated value) and the
 * receipt collection boundaries.
 */

function fakeAudioBuffer(
  channels: Float32Array[] = [new Float32Array([0.1, -0.2, 0.3]), new Float32Array([0.2, -0.1, 0.4])],
): AudioBuffer {
  return {
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate: 44100,
    duration: channels[0]!.length / 44100,
    getChannelData: (channel: number) => channels[channel]!,
  } as unknown as AudioBuffer;
}

function generatedAsset(overrides: Partial<UserSampleAsset> = {}): UserSampleAsset {
  return {
    id: "asset-1",
    name: "AI Vox",
    fileName: "ai-vox.wav",
    category: "Custom",
    duration: 2,
    sampleRate: 44100,
    channels: 1,
    createdAt: "2026-10-17T00:00:00.000Z",
    origin: "generated",
    generated: { providerId: "mrt2", modelId: "mrt2_small", inputHash: "in-1", prompt: "dark drill vox" },
    ...overrides,
  };
}

function manifestFor(doc: ReturnType<typeof createDefaultProject>, renderHash: string | null): RenderManifest {
  return buildRenderManifest({
    doc,
    scope: "master",
    mode: "song",
    sampleRate: 44100,
    bitDepth: 24,
    durationSec: 12.3456,
    renderHash,
    date: new Date("2026-10-17T10:00:00.000Z"),
  });
}

describe("render manifest — build", () => {
  it("is deterministic for the same project and injected clock", () => {
    const doc = createDefaultProject();
    const a = manifestFor(doc, "ab".repeat(32));
    const b = manifestFor(doc, "ab".repeat(32));
    expect(a).toEqual(b);
    expect(a.format).toBe(KYX_MANIFEST_FORMAT);
    expect(a.hash).toEqual({ algorithm: "SHA-256", scope: "float32-pcm-le", value: "ab".repeat(32) });
    expect(a.durationSec).toBe(12.346);
  });

  it("records an unavailable hash honestly instead of inventing one", () => {
    const manifest = manifestFor(createDefaultProject(), null);
    expect(manifest.hash.algorithm).toBeNull();
    expect(manifest.hash.value).toBeNull();
    expect(formatManifestSummary(manifest)).toContain("hash unavailable");
  });

  it("summarizes the hash prefix and AI receipts", () => {
    const doc = createDefaultProject();
    const manifest = manifestFor(doc, "0123456789abcdef".repeat(4));
    expect(formatManifestSummary(manifest)).toContain("hash 0123456789ab");
    expect(formatManifestSummary(manifest)).toContain("no AI provenance");
  });

  it("records the reproduction recipe (settings) and an optional scope label", () => {
    const doc = createDefaultProject();
    const manifest = buildRenderManifest({
      doc,
      scope: "stems",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 24,
      durationSec: 3,
      renderHash: "a".repeat(64),
      label: "drums stem",
      settings: { quality: "studio", masterProcessing: false, tailSeconds: 2 },
      date: new Date("2026-10-17T10:00:00.000Z"),
    });
    expect(manifest.label).toBe("drums stem");
    expect(manifest.settings).toEqual({
      mode: "song",
      sampleRate: 48000,
      quality: "studio",
      masterProcessing: false,
      tailSeconds: 2,
    });
    expect(reproductionSettings(manifest)).toEqual(manifest.settings);
    // A manifest without settings (pre-Wave-2 write) falls back to mode+rate
    // instead of inventing quality/masterProcessing values.
    const legacy = { ...manifest, settings: undefined };
    expect(reproductionSettings(legacy)).toEqual({ mode: "song", sampleRate: 48000 });
  });
});

describe("render manifest — last-export stamp registry", () => {
  it("remembers exactly the last export and can be cleared", () => {
    clearRenderStampForTests();
    expect(lastRenderStamp()).toBeNull();
    const manifest = manifestFor(createDefaultProject(), "b".repeat(64));
    const first = rememberRenderStamp({ manifest, fileName: "a.wav" });
    expect(first.recordedAt).toBeGreaterThan(0);
    rememberRenderStamp({ manifest, fileName: "b.wav" });
    expect(lastRenderStamp()?.fileName).toBe("b.wav");
    clearRenderStampForTests();
    expect(lastRenderStamp()).toBeNull();
  });
});

describe("render manifest — AI receipts", () => {
  it("includes only generated assets that are actually placed on the timeline", () => {
    const doc = createDefaultProject();
    const clips = [{ bufferId: "asset-1" }];
    (doc.arrangement as { audioClips?: unknown }).audioClips = clips;
    const receipts = collectAiAssetReceipts(doc, [
      generatedAsset({ id: "asset-1" }),
      generatedAsset({ id: "asset-unused" }),
      { ...generatedAsset({ id: "imported" }), origin: undefined, generated: undefined },
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ assetId: "asset-1", providerId: "mrt2", prompt: "dark drill vox" });
  });

  it("caps the asset list and truncates prompts", () => {
    const doc = createDefaultProject();
    const assets: UserSampleAsset[] = [];
    const clips: Array<{ bufferId: string }> = [];
    for (let index = 0; index < MANIFEST_MAX_ASSETS + 5; index += 1) {
      assets.push(
        generatedAsset({
          id: `asset-${index}`,
          generated: { providerId: "p", modelId: "m", inputHash: "h", prompt: "x".repeat(400) },
        }),
      );
      clips.push({ bufferId: `asset-${index}` });
    }
    (doc.arrangement as { audioClips?: unknown }).audioClips = clips;
    const receipts = collectAiAssetReceipts(doc, assets);
    expect(receipts).toHaveLength(MANIFEST_MAX_ASSETS);
    expect(receipts[0]!.prompt!.length).toBeLessThanOrEqual(160);
    expect(receipts[0]!.prompt!.endsWith("…")).toBe(true);
  });

  it("collects pattern and generative-track receipts from the document", () => {
    const doc = createDefaultProject();
    doc.patterns[0]!.generation = {
      engineId: "kyx-core",
      engineVersion: "1.2.0",
      seed: "seed-42",
      genre: "drill",
      style: null,
      grooveId: "groove.default",
      stepCount: 16,
      ghostWeight: 0.2,
      microWeight: 0.1,
      velocityVariation: 0.3,
      temperature: 0.8,
      sourcePatternId: null,
      outputContentHash: "deadbeef",
    };
    expect(collectAiPatternReceipts(doc)).toEqual([
      {
        patternId: doc.patterns[0]!.id,
        patternName: doc.patterns[0]!.name,
        engineId: "kyx-core",
        engineVersion: "1.2.0",
        seed: "seed-42",
        genre: "drill",
        outputContentHash: "deadbeef",
      },
    ]);
    expect(collectAiTrackReceipts(doc)).toEqual([]);
  });
});

describe("render manifest — hashing", () => {
  it("hashes deterministically and separates mono from dual-mono", async () => {
    const mono = [new Float32Array([0.5, -0.5])];
    const dualMono = [new Float32Array([0.5, -0.5]), new Float32Array([0.5, -0.5])];
    const a1 = await hashPcmChannels(mono);
    const a2 = await hashPcmChannels(mono);
    const b = await hashPcmChannels(dualMono);
    const c = await hashPcmChannels([new Float32Array([0.5, -0.499])]);
    expect(a1).not.toBeNull();
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(c).not.toBe(a1);
    expect(a1).toHaveLength(64);
  });

  it("hashes raw bytes through sha256Hex", async () => {
    // Known-answer: the SHA-256 of the empty input is a fixed constant.
    expect(await sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const hash = await sha256Hex(new TextEncoder().encode("kyx"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(await sha256Hex(new Uint8Array(0)));
  });
});

describe("render manifest — iXML round-trip", () => {
  it("survives encode → parse with hostile characters in names and prompts", () => {
    const doc = createDefaultProject();
    doc.name = "A & B <\"tag\"> 'x' — 日本";
    const assets = [
      generatedAsset({
        generated: { providerId: "p&p", modelId: "m<m>", inputHash: "h", prompt: 'say "cheese" & <smile>' },
      }),
    ];
    (doc.arrangement as { audioClips?: unknown }).audioClips = [{ bufferId: "asset-1" }];
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48000,
      bitDepth: 32,
      durationSec: 1,
      renderHash: "f".repeat(64),
      assets,
      date: new Date("2026-10-17T10:00:00.000Z"),
    });

    const wav = encodeWav(fakeAudioBuffer(), 24, {
      bext: createBextMetadata({ description: doc.name, date: new Date("2026-10-17T10:00:00.000Z") }),
      ixml: manifestToIxml(manifest),
    });

    const parsed = parseRenderManifestFromWav(new Uint8Array(wav));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(manifest);
    expect(parsed!.project.name).toBe("A & B <\"tag\"> 'x' — 日本");
    expect(parsed!.aiAssets[0]!.prompt).toBe('say "cheese" & <smile>');
  });

  it("keeps the file layout valid without an iXML chunk (no regression)", () => {
    const wav = new Uint8Array(encodeWav(fakeAudioBuffer(), 16));
    expect(parseRenderManifestFromWav(wav)).toBeNull();
    const view = new DataView(wav.buffer);
    // RIFF size counts everything after the first 8 bytes.
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  });

  it("accounts for the pad byte when the iXML payload is odd-length", () => {
    const doc = createDefaultProject();
    // Force an odd payload length by trimming one character if needed.
    let ixml = manifestToIxml(manifestFor(doc, "a".repeat(64)));
    if (ixml.length % 2 === 0) ixml += " ";
    const wav = new Uint8Array(encodeWav(fakeAudioBuffer(), 16, { ixml }));
    const view = new DataView(wav.buffer);
    expect(ixml.length % 2).toBe(1);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(parseRenderManifestFromWav(wav)).not.toBeNull();
  });

  it("degrades defensively on garbage input", () => {
    expect(parseRenderManifestFromWav(new Uint8Array())).toBeNull();
    expect(parseRenderManifestFromWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(manifestFromIxml("<BWFXML><OTHER>{}</OTHER></BWFXML>")).toBeNull();
    expect(manifestFromIxml("<BWFXML><KYX>not json</KYX></BWFXML>")).toBeNull();
    expect(manifestFromIxml(`<BWFXML><KYX>{"format":"other/9"}</KYX></BWFXML>`)).toBeNull();
    // A truncated iXML chunk (declared size past EOF) must not throw.
    const wav = new Uint8Array(
      encodeWav(fakeAudioBuffer(), 16, { ixml: manifestToIxml(manifestFor(createDefaultProject(), null)) }),
    );
    expect(parseRenderManifestFromWav(wav.subarray(0, 50))).toBeNull();
    // Cutting only the audio tail (the iXML header is intact) still parses.
    expect(parseRenderManifestFromWav(wav.subarray(0, wav.byteLength - 20))).not.toBeNull();
  });
});

describe("render manifest — verification", () => {
  const channels = [new Float32Array([0.25, -0.25])];

  it("proves a bit-identical re-render", async () => {
    const doc = createDefaultProject();
    const manifest = manifestFor(doc, await hashPcmChannels(channels));
    const verdict = await verifyRenderManifest(manifest, { docId: doc.id, channels });
    expect(verdict.status).toBe("match");
    expect(verdict.detail).toContain("Bit-identical");
  });

  it("reports a mismatch after an edit", async () => {
    const doc = createDefaultProject();
    const manifest = manifestFor(doc, await hashPcmChannels(channels));
    const verdict = await verifyRenderManifest(manifest, { docId: doc.id, channels: [new Float32Array([0.25, -0.2])] });
    expect(verdict.status).toBe("hash-mismatch");
  });

  it("refuses to verify a different project or a hash-less file", async () => {
    const doc = createDefaultProject();
    const other = await verifyRenderManifest(manifestFor(doc, "a".repeat(64)), { docId: "other-id", channels });
    expect(other.status).toBe("project-mismatch");
    const none = await verifyRenderManifest(manifestFor(doc, null), { docId: doc.id, channels });
    expect(none.status).toBe("hash-unavailable");
  });
});
