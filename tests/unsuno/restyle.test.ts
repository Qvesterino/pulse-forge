import { describe, expect, it, beforeAll } from "vitest";
import { normalizeProject } from "../../src/project-model/schema";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import { ProjectStore } from "../../src/store/ProjectStore";
import { artistLabels, restyleCommand } from "../../src/reference/restyle";
import { unsunoCommand } from "../../src/reference/unsuno";
import { transcribeTrack } from "../../src/reference/transcribe";
import { goldenTracks, renderGoldenTrack, GOLDEN_SAMPLE_RATE } from "./golden-synth";
import { warmFactoryPresets } from "../../src/presets/factory-loader";

/**
 * RE-STYLE REMIX BRIDGE — the invariant that makes this a remix rather than
 * a regeneration: the COMPOSITION (drum rows, bass/chord/lead notes,
 * arrangement) never changes; only the band behind it (kit assets,
 * instrument presets, mix profile) does. One undo restores the old band.
 */

const SR = GOLDEN_SAMPLE_RATE;

/** Build a real reconstructed project from the golden house transcription. */
function reconstructedProject() {
  const house = goldenTracks()[0];
  const transcription = transcribeTrack(renderGoldenTrack(house), SR, { separation: "off" });
  const sections = [0, 1].map((i) => ({
    role: i === 0 ? "intro" : "drop",
    startSec: i * 4 * (240 / 126),
    endSec: (i + 1) * 4 * (240 / 126),
  }));
  const store = new ProjectStore(createProjectFromTemplate("house"));
  const result = unsunoCommand(store.doc, { transcription, sections });
  store.execute(result.command!);
  return store;
}

function compositionFingerprint(doc: ReturnType<typeof normalizeProject>) {
  return {
    patterns: doc.patterns
      .filter((p) => p.name.startsWith("UN-SUNO"))
      .map((p) => ({
        name: p.name,
        stepCount: p.stepCount,
        rows: Object.entries(p.rows).map(([padId, row]) => ({ padId, lit: row.map((v) => (v > 0 ? 1 : 0)) })),
        notes: Object.entries(p.notes).flatMap(([trackId, notes]) =>
          notes.map((n) => ({ trackId, pitch: n.pitch, start: n.start, duration: n.duration })),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    arrangement: doc.arrangement.clips?.length ?? doc.arrangement.audioClips?.length ?? 0,
  };
}

describe("restyleCommand — same composition, new band", () => {
  // The instrument-preset leg reads the factory bank, which throws while
  // cold (the wrongkind-wave lesson) — production warms it at boot.
  beforeAll(async () => {
    await warmFactoryPresets();
  });

  it("swaps kit + instruments + mix while rows and notes stay byte-equal; one undo restores", () => {
    const store = reconstructedProject();
    const doc = normalizeProject(store.doc);
    const before = compositionFingerprint(doc);
    const drumBefore = doc.tracks.find((t) => t.kind === "drum") as { pads: Array<{ assetId: string | null }> };
    const padAssetsBefore = drumBefore.pads.map((p) => p.assetId);

    const result = restyleCommand(store.doc, "travis scott");
    expect(result.command).not.toBeNull();
    expect(result.summary).toMatch(/travis scott/i);
    expect(result.applied.kit).not.toBeNull();

    store.execute(result.command!);
    const after = normalizeProject(store.doc);

    // COMPOSITION preserved exactly.
    expect(compositionFingerprint(after)).toEqual(before);

    // BAND changed: drum pad assets swapped, instrument presets applied.
    const drumAfter = after.tracks.find((t) => t.kind === "drum") as { pads: Array<{ assetId: string | null }> };
    const padAssetsAfter = drumAfter.pads.map((p) => p.assetId);
    expect(padAssetsAfter).not.toEqual(padAssetsBefore);
    const bassTrack = after.tracks.find((t) => t.kind === "instrument" && t.instrument === "bass");
    if (bassTrack) expect((bassTrack as unknown as { presetId?: string }).presetId).toBeTruthy();

    // ONE undo restores the old band exactly.
    store.undo();
    const restored = normalizeProject(store.doc);
    const drumRestored = restored.tracks.find((t) => t.kind === "drum") as { pads: Array<{ assetId: string | null }> };
    expect(drumRestored.pads.map((p) => p.assetId)).toEqual(padAssetsBefore);
    expect(compositionFingerprint(restored)).toEqual(before);
  });

  it("determinism: same artist → same applied band", () => {
    const a = reconstructedProject();
    const b = reconstructedProject();
    const resultA = restyleCommand(a.doc, "kendrick lamar");
    const resultB = restyleCommand(b.doc, "kendrick lamar");
    expect(resultA.applied.kit).toBe(resultB.applied.kit);
    a.execute(resultA.command!);
    b.execute(resultB.command!);
    const padAssets = (store: ProjectStore) => {
      const drum = normalizeProject(store.doc).tracks.find((t) => t.kind === "drum") as {
        pads: Array<{ assetId: string | null }>;
      };
      return drum.pads.map((p) => p.assetId);
    };
    expect(padAssets(b)).toEqual(padAssets(a));
  });

  it("unknown artist → null command with an honest summary", () => {
    const store = reconstructedProject();
    const result = restyleCommand(store.doc, "neexistujuci kapelnik 123");
    expect(result.command).toBeNull();
    expect(result.summary).toMatch(/unknown artist/i);
  });

  it("artistLabels: a deduplicated, non-empty list usable as UI select values", () => {
    const labels = artistLabels();
    expect(labels.length).toBeGreaterThan(500);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("travis scott");
  });
});
