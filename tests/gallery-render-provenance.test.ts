import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import { createCollabServer } from "../server/collab-server.mjs";
import {
  GALLERY_RENDER_FORMAT,
  MAX_GALLERY_MODELS,
  provenanceFromStamp,
  provenanceModelCount,
  provenanceVerifyHint,
  sanitizeGalleryRenderProvenance,
} from "../src/gallery/galleryProvenance";
import {
  buildRenderManifest,
  hashPcmChannels,
  manifestToIxml,
  type LastRenderStamp,
} from "../src/export/renderManifest";
import { encodeWav } from "../src/rendering/wav";
import { createDefaultProject } from "../src/project-model/schema";
import type { UserSampleAsset } from "../src/persistence/UserSampleRepository";

/**
 * VERIFIABLE GALLERY — render provenance.
 *
 * The claim a published beat can carry: the SHA-256 of the export's PCM plus
 * the AI receipts. Two specs carry the weight here: the SERVER refuses a
 * malformed claim instead of storing it (a stored claim nobody can check is
 * worse than none), and the server and client sanitizers are pinned to AGREE,
 * because two validators with different bounds is how "verifiable" becomes a
 * lie at the edges.
 */

const HASH = "a".repeat(64);

function validRender(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: HASH,
    algorithm: "SHA-256",
    manifestFormat: "kyx-render-manifest/1",
    models: ["mrt2/mrt2_small"],
    ...overrides,
  };
}

function validCode(): string {
  return compressToEncodedURIComponent(JSON.stringify({ tracks: [{ id: "t1", kind: "drum", name: "drums" }] }));
}

describe("server — render provenance is validated, never trusted", () => {
  it("stores exactly the declared fields for a valid claim (sorted, deduped models)", () => {
    const { gallery } = createCollabServer();
    const result = gallery.add({
      title: "verified",
      author: "qvester",
      code: validCode(),
      render: validRender({ models: ["b/model", "a/model", "b/model"] }),
    });
    expect(result.error).toBeUndefined();
    const listed = (gallery.list() as Array<Record<string, unknown>>).find((item) => item.id === result.item?.id);
    expect(listed?.render).toEqual({
      hash: HASH,
      algorithm: "SHA-256",
      manifestFormat: "kyx-render-manifest/1",
      models: ["a/model", "b/model"],
    });
  });

  it("REFUSES a malformed claim and stores nothing", () => {
    const { gallery } = createCollabServer();
    const before = gallery.list().length;
    for (const bad of [
      validRender({ hash: "not-a-hash" }),
      validRender({ hash: "A".repeat(64) }), // uppercase is not the protocol's hex
      validRender({ algorithm: "MD5" }),
      validRender({ manifestFormat: "" }),
      "render",
      [1, 2, 3],
    ]) {
      const result = gallery.add({ title: "bad claim", author: "anon", code: validCode(), render: bad });
      expect(result.error, `must refuse ${JSON.stringify(bad).slice(0, 40)}`).toMatch(/render provenance is malformed/);
    }
    expect(gallery.list().length).toBe(before);
  });

  it("caps the model list instead of storing an unbounded receipt dump", () => {
    const { gallery } = createCollabServer();
    const many = Array.from({ length: 40 }, (_, index) => `p/m${String(index).padStart(2, "0")}`);
    const result = gallery.add({
      title: "many models",
      author: "anon",
      code: validCode(),
      render: validRender({ models: many }),
    });
    expect(result.error).toBeUndefined();
    const listed = (gallery.list() as Array<Record<string, unknown>>).find((item) => item.id === result.item?.id);
    expect((listed?.render as { models: string[] }).models).toHaveLength(MAX_GALLERY_MODELS);
  });

  it("a beat without provenance makes no claim (null, not a fake badge)", () => {
    const { gallery } = createCollabServer();
    const result = gallery.add({ title: "plain", author: "anon", code: validCode() });
    expect(result.error).toBeUndefined();
    const listed = (gallery.list() as Array<Record<string, unknown>>).find((item) => item.id === result.item?.id);
    expect(listed?.render ?? null).toBeNull();
  });
});

describe("client and server sanitizers AGREE (two validators, one truth)", () => {
  const table: Array<[string, unknown]> = [
    ["valid", validRender()],
    ["valid, no models", validRender({ models: [] })],
    ["models junk", validRender({ models: ["ok/model", 42, "", null, "x".repeat(200)] })],
    ["models not an array", validRender({ models: "mrt2" })],
    ["short hash", validRender({ hash: "abc" })],
    ["uppercase hash", validRender({ hash: "A".repeat(64) })],
    ["wrong algorithm", validRender({ algorithm: "SHA-1" })],
    ["missing format", validRender({ manifestFormat: "" })],
    ["extra fields ignored", validRender({ note: "hello", extra: { deep: true } })],
    ["null", null],
    ["undefined", undefined],
    ["string", "nope"],
    ["array", [1, 2]],
    ["number", 7],
  ];

  it("agrees on accept/reject and on the normalized shape for every case", () => {
    for (const [label, value] of table) {
      const client = sanitizeGalleryRenderProvenance(value);
      // Through the store's PUBLIC contract, not an internal helper: what a
      // client may publish is exactly what the server stores.
      const { gallery } = createCollabServer();
      const result = gallery.add({ title: "t", author: "a", code: validCode(), render: value });
      const serverAccepted = result.error === undefined;
      const listed = serverAccepted
        ? (gallery.list() as Array<Record<string, unknown>>).find((item) => item.id === result.item?.id)
        : null;

      if (value == null) {
        // ABSENT provenance is not a rejection — it is "no claim", on both sides.
        expect(client, `absent case differs for: ${label}`).toBeNull();
        expect(serverAccepted, `server refused an absent claim for: ${label}`).toBe(true);
        expect(listed?.render ?? null).toBeNull();
        continue;
      }
      expect(client === null, `client/server verdict differs for: ${label}`).toBe(!serverAccepted);
      if (client !== null && serverAccepted) {
        expect(client, `normalized shape differs for: ${label}`).toEqual(listed?.render ?? null);
      }
    }
  });

  it("pins the shared bounds and the format constant", () => {
    expect(GALLERY_RENDER_FORMAT).toBe("kyx-render-provenance/1");
    // The client's cap and the server's cap are the same number, by test.
    const many = Array.from({ length: 40 }, (_, index) => `p/m${String(index).padStart(2, "0")}`);
    expect((sanitizeGalleryRenderProvenance(validRender({ models: many }))?.models ?? []).length).toBe(
      MAX_GALLERY_MODELS,
    );
  });
});

describe("END-TO-END — the hash the gallery stores is the one the verifier checks", () => {
  it("publish a beat with a real render hash, then verify the exported file with the stored hash", async () => {
    // The full loop the badge promises a reader: the artist exports a stamped
    // master, the gallery stores its hash, and anyone can download the file and
    // check it against that hash with the PUBLIC verifier. Every step here is
    // the real code path — the encoder, the manifest builder, the store's
    // sanitizer and the CLI process.
    const sampleRate = 44_100;
    const length = 4096;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      left[index] = Math.sin(index * 0.01) * 0.5;
      right[index] = Math.cos(index * 0.013) * 0.4;
    }
    const buffer = {
      numberOfChannels: 2,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    } as unknown as AudioBuffer;

    const doc = createDefaultProject();
    const renderHash = await hashPcmChannels([left, right]);
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate,
      bitDepth: 32,
      durationSec: buffer.duration,
      renderHash,
      date: new Date("2026-10-17T00:00:00.000Z"),
    });
    const provenance = provenanceFromStamp({ manifest, fileName: "beat-master.wav", recordedAt: 1 });
    expect(provenance).not.toBeNull();

    const { gallery } = createCollabServer();
    const published = gallery.add({
      title: "verifiable loop",
      author: "qvester",
      code: validCode(),
      render: provenance,
    });
    expect(published.error).toBeUndefined();
    const stored = (gallery.list() as Array<Record<string, unknown>>).find((item) => item.id === published.item?.id);
    const storedHash = (stored?.render as { hash?: string } | null)?.hash;
    expect(storedHash).toBe(renderHash);

    // The file the artist exported in the first place.
    const dir = mkdtempSync(join(tmpdir(), "kyx-gallery-e2e-"));
    const wav = join(dir, "beat-master.wav");
    writeFileSync(wav, new Uint8Array(encodeWav(buffer, 32, { ixml: manifestToIxml(manifest) })));

    // A reader downloads it and checks it against what the gallery claims.
    const verified = execFileSync(process.execPath, ["tools/kyx-verify/kyx-verify.mjs", wav, "--expect", storedHash!], {
      encoding: "utf8",
    });
    expect(verified).toContain("VERIFIED");
    expect(verified).toContain("MATCH");
  }, 30_000);
});

describe("provenanceFromStamp — built from the real export stamp", () => {
  function stamp(hash: string | null): LastRenderStamp {
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
    };
    const manifest = buildRenderManifest({
      doc,
      scope: "master",
      mode: "song",
      sampleRate: 48_000,
      bitDepth: 32,
      durationSec: 1,
      renderHash: hash,
      assets: [] as readonly UserSampleAsset[],
      date: new Date("2026-10-17T00:00:00.000Z"),
    });
    return { manifest, fileName: "beat-master.wav", recordedAt: 1 };
  }

  it("carries the hash and the model receipts of the export", () => {
    const provenance = provenanceFromStamp(stamp(HASH));
    expect(provenance).toMatchObject({ hash: HASH, algorithm: "SHA-256" });
    expect(provenance?.models).toContain("kyx-core@1.2.0");
    expect(provenanceModelCount(provenance)).toBeGreaterThan(0);
    expect(provenanceVerifyHint(provenance!)).toContain(HASH);
    expect(provenanceVerifyHint(provenance!)).toContain("npx kyx-verify");
  });

  it("makes NO claim without a render hash (unexported or insecure context)", () => {
    expect(provenanceFromStamp(stamp(null))).toBeNull();
    expect(provenanceFromStamp(null)).toBeNull();
  });
});
