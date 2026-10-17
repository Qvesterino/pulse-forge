import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import { createCollabServer, sanitizeGalleryRender as serverSanitize } from "../server/collab-server.mjs";
import {
  GALLERY_RENDER_FORMAT,
  MAX_GALLERY_MODELS,
  provenanceFromStamp,
  provenanceModelCount,
  provenanceVerifyHint,
  sanitizeGalleryRenderProvenance,
} from "../src/gallery/galleryProvenance";
import { buildRenderManifest, type LastRenderStamp } from "../src/export/renderManifest";
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
      const server = serverSanitize(value);
      expect(client === null, `client/server verdict differs for: ${label}`).toBe(server === null);
      if (client !== null && server !== null) {
        expect(client, `normalized shape differs for: ${label}`).toEqual(server);
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
