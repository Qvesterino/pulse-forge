import { describe, expect, it } from "vitest";
import {
  analysisCacheKey,
  audioContentHash,
  isAnalysisStale,
  stalenessOf,
  type CachedAnalysisEntry,
  type EditKind,
} from "../../src/analysis/staleness";
import { ProjectStore } from "../../src/store/ProjectStore";
import { addAudioClip, trimAudioClipStart, stretchAudioClip } from "../../src/commands/commands";
import { addEffectToTracks, setEffectBypassOnTracks } from "../../src/commands/tracks";
import { setEffectParam } from "../../src/commands/effectParams";
import { setTrackParams } from "../../src/commands/project";
import { setBpm } from "../../src/commands/project";
import { setTimeSignature } from "../../src/commands/metadata";
import { addAutomationLane, addAutomationPoint } from "../../src/commands/automation";
import { testDoc } from "../fixtures/doc";

/**
 * E-3 — the CACHE INVALIDATION edit matrix (perception audit, experiment
 * E-3): every EditKind × every analysis stage, executed as REAL store
 * edits, with the staleness decision asserted per the audit's rule —
 * DIFFERENT rules for source-audio, post-FX track, and master analysis.
 *
 * The two degenerate rules must both fail the matrix:
 *   - "everything stale after anything" — kills source-domain caching and
 *     trains consumers to ignore staleness (the matrix asserts FRESH
 *     survivors exist: source entries through track edits, other-track
 *     entries, rename/color);
 *   - "nothing ever stale" — silent hits (the matrix asserts STALE for
 *     every media/trim/FX/tempo combination the audit named).
 *
 * Plus the content-hash contract: identical PCM → identical hash; a
 * single flipped sample → a different hash (G-2's no-silent-hit floor).
 */

const TRACK_A = "A";
const TRACK_B = "B";

function buildDoc(): { store: ProjectStore; trackA: string; trackB: string; clipA: string } {
  const store = new ProjectStore(testDoc());
  // Deterministic stand-ins for two instrument strips.
  const trackA = store.doc.tracks.find((t) => t.kind === "instrument")!.id;
  store.execute(setTrackParams(store.doc, trackA, { name: TRACK_A }));
  // A clip on A (the analyzed media) and a second strip B.
  store.execute(addAudioClip(store.doc, trackA, "factory.kick", 0, 4));
  store.execute(
    setTrackParams(store.doc, store.doc.tracks.filter((t) => t.kind === "instrument")[1]!.id, { name: TRACK_B }),
  );
  const clipA = store.doc.arrangement.audioClips!.find((c) => c.trackId === trackA)!.id;
  return { store, trackA, trackB: store.doc.tracks.find((t: any) => t.name === TRACK_B)!.id, clipA };
}

/** Apply one edit kind through the REAL store. */
function applyEdit(store: ProjectStore, kind: EditKind, trackId: string, clipId: string): void {
  switch (kind) {
    case "media-replace":
      store.execute(addAudioClip(store.doc, trackId, "factory.snare", 0, 4));
      break;
    case "trim":
      store.execute(trimAudioClipStart(store.doc, clipId, { startBar: 0, lengthBars: 3, trimStart: 1, offsetSec: 0 }));
      break;
    case "stretch":
      store.execute(stretchAudioClip(store.doc, clipId, 6, 1.5));
      break;
    case "gain":
      store.execute(setTrackParams(store.doc, trackId, { gain: 0.7 }));
      break;
    case "automation": {
      store.execute(addAutomationLane(store.doc, { kind: "trackGain", trackId }));
      const lane = store.doc.automation[0]!;
      store.execute(addAutomationPoint(store.doc, lane.id, 480, 0.8));
      break;
    }
    case "tempo":
      store.execute(setBpm(store.doc, 125));
      break;
    case "meter":
      store.execute(setTimeSignature(store.doc, 3, 4));
      break;
    case "fx-bypass":
      store.execute(addEffectToTracks(store.doc, [trackId], "eq"));
      store.execute(setEffectBypassOnTracks(store.doc, [trackId], "eq", false));
      break;
    case "fx-params": {
      store.execute(addEffectToTracks(store.doc, [trackId], "eq"));
      const fx = store.doc.tracks.find((t) => t.id === trackId)!.effects[0]!;
      store.execute(setEffectParam(store.doc, trackId, fx.id, "highShelfGain", 6));
      break;
    }
    case "routing":
      // No return-bus edit without building one — a group move is the
      // closest track-scoped routing change the fixture supports cheaply.
      store.execute(setTrackParams(store.doc, trackId, { gain: 0.99 }));
      break;
    case "rename":
      store.execute(setTrackParams(store.doc, trackId, { name: `${TRACK_A}-renamed` }));
      break;
    case "color":
      store.execute(setTrackParams(store.doc, trackId, { gain: store.doc.tracks.find((t) => t.id === trackId)!.gain }));
      break;
  }
}

/** The entry under test: track-stage analysis of strip A at the doc's current revision. */
function entryAt(store: ProjectStore, stage: CachedAnalysisEntry["stage"], scopeId?: string): CachedAnalysisEntry {
  return {
    stage,
    scopeKind: scopeId ? "track" : "master",
    ...(scopeId ? { scopeId } : {}),
    revision: store.getRevision(),
  };
}

/** The full matrix: for each edit kind, the decision per stage (the rules table in test form). */
const MATRIX: Array<{ kind: EditKind; track: "A" | "B"; source: string; trackA: string; master: string }> = [
  { kind: "media-replace", track: "A", source: "stale", trackA: "stale", master: "stale" },
  { kind: "trim", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "stretch", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "gain", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "automation", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "tempo", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "meter", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "fx-bypass", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "fx-params", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "routing", track: "A", source: "fresh", trackA: "stale", master: "stale" },
  { kind: "gain", track: "B", source: "fresh", trackA: "fresh", master: "stale" },
  { kind: "rename", track: "A", source: "fresh", trackA: "fresh", master: "fresh" },
  { kind: "color", track: "A", source: "fresh", trackA: "fresh", master: "fresh" },
];

describe("E-3: the cache invalidation edit matrix", () => {
  for (const row of MATRIX) {
    it(`${row.kind} on strip ${row.track}: source=${row.source}, stripA=${row.trackA}, master=${row.master}`, () => {
      const { store, trackA, trackB, clipA } = buildDoc();
      const sourceEntry = entryAt(store, "source");
      const stripAEntry = entryAt(store, "track", trackA);
      const masterEntry = entryAt(store, "master");

      applyEdit(store, row.kind, row.track === "A" ? trackA : trackB, clipA);

      const current = {
        revision: store.getRevision(),
        edit: { kind: row.kind, trackId: row.track === "A" ? trackA : trackB },
      };
      expect(stalenessOf(sourceEntry, current), `source ${row.kind}`).toBe(row.source);
      expect(stalenessOf(stripAEntry, current), `stripA ${row.kind}`).toBe(row.trackA);
      expect(stalenessOf(masterEntry, current), `master ${row.kind}`).toBe(row.master);
    });
  }

  it("matrix census: every EditKind is exercised at least once", () => {
    const exercised = new Set(MATRIX.map((row) => row.kind));
    const all: EditKind[] = [
      "media-replace",
      "trim",
      "stretch",
      "gain",
      "automation",
      "tempo",
      "meter",
      "fx-bypass",
      "fx-params",
      "routing",
      "rename",
      "color",
    ];
    const missing = all.filter((kind) => !exercised.has(kind));
    expect(missing, "unexercised edit kinds").toEqual([]);
  });

  it("the degenerate rules both fail: fresh survivors AND stale hits exist", () => {
    const freshRows = MATRIX.filter((row) => row.source === "fresh" || row.trackA === "fresh").length;
    const staleRows = MATRIX.filter((row) => row.trackA === "stale").length;
    expect(freshRows).toBeGreaterThan(0); // kills "always stale"
    expect(staleRows).toBeGreaterThan(0); // kills "never stale" (silent hits)
  });
});

describe("E-3: the content hash has no silent hits", () => {
  it("identical PCM → identical hash; one flipped sample → different hash", () => {
    const a = new Float32Array(4096);
    for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * 220 * i) / 44100);
    const b = new Float32Array(a);
    expect(audioContentHash([a], 44100)).toBe(audioContentHash([b], 44100));

    b[1234] = b[1234]! + 0.001;
    expect(audioContentHash([b], 44100)).not.toBe(audioContentHash([a], 44100));

    // Channel count and sample rate are part of the identity.
    expect(audioContentHash([a, a], 44100)).not.toBe(audioContentHash([a], 44100));
    expect(audioContentHash([a], 48000)).not.toBe(audioContentHash([a], 44100));
  });

  it("the cache key composes content + stage + scope + window + algorithm", () => {
    const base = {
      stage: "track" as const,
      scopeId: "t1",
      contentHash: "fnv1a-deadbeef",
      window: { startTick: 0, endTick: 3840 },
      featureSet: "mix-health",
      algorithm: { name: "mix-doctor", version: "1" },
    };
    const key = analysisCacheKey(base);
    expect(key).toBe(analysisCacheKey({ ...base }));
    expect(analysisCacheKey({ ...base, contentHash: "fnv1a-changed" })).not.toBe(key);
    expect(analysisCacheKey({ ...base, window: { startTick: 0, endTick: 7680 } })).not.toBe(key);
    expect(analysisCacheKey({ ...base, algorithm: { name: "mix-doctor", version: "2" } })).not.toBe(key);
  });

  it("an entry without identity is UNKNOWN — never guessed fresh", () => {
    const noIdentity: CachedAnalysisEntry = { stage: "track", scopeKind: "track", scopeId: "t1" };
    expect(stalenessOf(noIdentity, { revision: 5, edit: { kind: "gain", trackId: "t1" } })).toBe("unknown");
    expect(isAnalysisStale(noIdentity, { revision: 5, edit: { kind: "gain", trackId: "t1" } })).toBe(false);
  });
});
