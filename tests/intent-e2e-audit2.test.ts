import { describe, it, expect } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { applyExactIntentCommand, applyProductionIntentCommand, exactReadback } from "../src/commands/commands";
import { applyCompoundIntent } from "../src/intent/compound";
import { applyEffectIntent } from "../src/intent/mix";
import { resolveProductionTargets } from "../src/intent/production";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import type { AudioClip, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * INTENT ENGINE END-TO-END AUDIT — WAVE 2 (2026-09-28).
 *
 * Regression coverage for the four defects confirmed by the wave-2 probes,
 * plus the pinned safety behaviors the audit documented:
 *
 *   FIX 1  generation prompts carrying an explicit bpm ("dark techno at
 *          142 bpm") were hijacked into a silent tempo-set by the exact
 *          layer's loose "N bpm" pattern — the beat never generated.
 *   FIX 2  unnamed transposes ("transpose it up an octave") guessed "lead"
 *          and, via the resolver's positional fallback, mutated whatever
 *          instrument happened to be first. Named-but-absent transpose
 *          targets used to be silent no-ops reporting success.
 *   FIX 3  resolveProductionTargets' lead → instruments[0] fallback routed
 *          lead-named production/fader/effect asks onto the wrong track
 *          (usually the bass) — a silent wrong-target mutation.
 *   FIX 4  exactReadback had no transpose entry, so the status line could
 *          not verify a transpose actually landed.
 */

const instrumentTracks = (doc: ProjectDocument): InstrumentTrack[] =>
  doc.tracks.filter((t): t is InstrumentTrack => t.kind === "instrument");

/** House fixture with every lead-family instrument track removed. */
function noLeadDoc(): ProjectDocument {
  const doc = testDoc();
  const lead = (t: InstrumentTrack) =>
    /\blead\b|\bsynth\b|\bpluck\b/i.test(t.name) || ["lead", "pluck", "spectral"].includes(t.instrument);
  const keep = new Set(
    instrumentTracks(doc)
      .filter((t) => !lead(t))
      .map((t) => t.id),
  );
  return { ...doc, tracks: doc.tracks.filter((t) => t.kind !== "instrument" || keep.has(t.id)) };
}

const activeNotes = (doc: ProjectDocument): Record<string, number[]> => {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const out: Record<string, number[]> = {};
  for (const [trackId, notes] of Object.entries(pattern?.notes ?? {})) {
    out[trackId] = notes.map((n) => n.pitch);
  }
  return out;
};

// ─── FIX 1: genre prompts with an explicit bpm stay GENERATION intents ──────

describe("E2E audit2 FIX 1: bpm in a genre prompt is descriptive, not a command", () => {
  it("'dark techno at 142 bpm' routes to pattern generation, not a tempo set", () => {
    const route = routeIntentText("dark techno at 142 bpm", testDoc());
    expect(route.kind).toBe("pattern");
  });

  it("'hard techno 150 bpm' and 'trap at 140 bpm with dark lead' stay prompts", () => {
    expect(routeIntentText("hard techno 150 bpm", testDoc()).kind).toBe("pattern");
    expect(routeIntentText("trap at 140 bpm with dark lead", testDoc()).kind).toBe("pattern");
  });

  it("the explicit 'tempo' word still fires next to a genre ('hard techno tempo to 150')", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("hard techno tempo to 150", store.getDoc());
    expect(route.kind).toBe("exact");
    if (route.kind !== "exact") return;
    store.execute(applyExactIntentCommand(store.getDoc(), route.plan));
    expect(store.getDoc().bpm).toBe(150);
  });

  it("bare bpm phrases without a genre keep the exact tempo route ('142 bpm')", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("142 bpm", store.getDoc());
    expect(route.kind).toBe("exact");
    if (route.kind !== "exact") return;
    store.execute(applyExactIntentCommand(store.getDoc(), route.plan));
    expect(store.getDoc().bpm).toBe(142);
  });
});

// ─── FIX 2 + FIX 3: no silent target guessing ───────────────────────────────

describe("E2E audit2 FIX 2: transpose never guesses a target", () => {
  it("'transpose it up an octave' on a leadless doc mutates NOTHING (no lead guess)", () => {
    const doc = noLeadDoc();
    const route = routeIntentText("transpose it up an octave", doc);
    expect(route.kind).not.toBe("exact");
    expect(activeNotes(doc)).toEqual(activeNotes(doc)); // fixture sanity
  });

  it("named-but-absent target ('transpose the lead…' with no lead) fails LOUDLY and atomically", () => {
    const doc = noLeadDoc();
    const store = new ProjectStore(doc);
    const route = routeIntentText("transpose the lead up one octave", store.getDoc());
    expect(route.kind).toBe("exact");
    if (route.kind !== "exact") return;
    expect(() => applyExactIntentCommand(store.getDoc(), route.plan)).toThrow(/nothing to transpose/);
    expect(store.getDoc()).toBe(doc); // untouched — the throw happened at build time
  });

  it("'transpose the drums up one octave' declines at the applier (drums have no pitch)", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("transpose the drums up one octave", store.getDoc());
    expect(route.kind).toBe("exact");
    if (route.kind !== "exact") return;
    expect(() => applyExactIntentCommand(store.getDoc(), route.plan)).toThrow(/no melodic track/);
  });

  it("a resolvable named transpose still lands, reads back, and undoes", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    const bass = instrumentTracks(doc).find((t) => /bass|808/i.test(t.name));
    if (!bass) throw new Error("fixture: house template has no bass track");
    const before = activeNotes(doc)[bass.id] ?? [];
    expect(before.length).toBeGreaterThan(0);
    const route = routeIntentText("transpose the bass up one octave", store.getDoc());
    expect(route.kind).toBe("exact");
    if (route.kind !== "exact") return;
    store.execute(applyExactIntentCommand(store.getDoc(), route.plan));
    const after = activeNotes(store.getDoc())[bass.id] ?? [];
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4).map((p) => p + 12));
    // FIX 4: the readback now verifies the landing
    expect(exactReadback(doc, store.getDoc(), route.plan)).toContain("transpose +12 st ✓");
    store.undo();
    expect(activeNotes(store.getDoc())[bass.id] ?? []).toEqual(before);
  });

  it("SK named transpose still parses ('posun lead hore o 2 semitony' needs the lead)", () => {
    const doc = noLeadDoc();
    // no lead in the doc → the SK branch declines too (no "lead" guess)
    expect(routeIntentText("posun hore o 2 semitony", doc).kind).not.toBe("exact");
  });
});

describe("E2E audit2 FIX 3: production target resolution is strict", () => {
  it("resolveProductionTargets('lead') no longer falls back to instruments[0]", () => {
    const doc = noLeadDoc();
    const firstInstrument = instrumentTracks(doc)[0];
    if (!firstInstrument) throw new Error("fixture: no instruments");
    const ids = resolveProductionTargets(doc, ["lead"]);
    expect(ids).not.toContain(firstInstrument.id);
    expect(ids).toEqual([]);
  });

  it("'make the lead deeper' with no lead track throws — the bass stays untouched", () => {
    const doc = noLeadDoc();
    const store = new ProjectStore(doc);
    const route = routeIntentText("make the lead deeper", doc);
    expect(route.kind).toBe("production");
    if (route.kind !== "production") return;
    expect(() => applyProductionIntentCommand(store.getDoc(), route.intent)).toThrow(/No matching track/);
    const effectsAfter = store
      .getDoc()
      .tracks.filter((t) => t.kind !== "group" && t.effects.length > 0)
      .map((t) => t.name);
    expect(effectsAfter).toEqual([]); // nothing was installed anywhere
  });

  it("bass-family targets still resolve by kind and name on the same doc", () => {
    const doc = noLeadDoc();
    expect(resolveProductionTargets(doc, ["bass"]).length).toBe(1);
    expect(resolveProductionTargets(doc, ["drums"]).length).toBe(1);
  });
});

// ─── Verification loop: the audit's canonical worked example ────────────────

describe("E2E audit2 verification loop: 'set the vocal reverb mix to 25%'", () => {
  it("finds the take-carrying track, adds reverb, lands mix at 25% of range, one undo", () => {
    const doc = testDoc();
    const victim = instrumentTracks(doc)[0];
    if (!victim) throw new Error("fixture: no instruments");
    const clip: AudioClip = {
      id: "clip-vocal-audit2",
      trackId: victim.id,
      bufferId: "buf-audit2",
      startBar: 0,
      lengthBars: 2,
      offsetSec: 0,
      trimStart: 0,
      trimEnd: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      stretchRate: 1,
      reverse: false,
    };
    const withTake: ProjectDocument = { ...doc, arrangement: { ...doc.arrangement, audioClips: [clip] } };
    const store = new ProjectStore(withTake);
    const route = routeIntentText("set the vocal reverb mix to 25%", store.getDoc());
    expect(route.kind).toBe("effectIntent");
    if (route.kind !== "effectIntent") return;
    expect(route.intent.targets).toContain("vocal");
    store.execute(applyEffectIntent(store.getDoc(), route.intent));
    const track = store.getDoc().tracks.find((t) => t.id === victim.id) as InstrumentTrack;
    const reverb = track.effects.find((e) => e.type === "reverb");
    expect(reverb).toBeDefined();
    expect(reverb?.params.mix).toBeCloseTo(0.25, 5); // 25% of the mix knob's range
    store.undo();
    const undone = store.getDoc().tracks.find((t) => t.id === victim.id) as InstrumentTrack;
    expect(undone.effects.some((e) => e.type === "reverb")).toBe(false);
  });
});

// ─── Atomicity + clamps + pinned fallback behaviors ─────────────────────────

describe("E2E audit2 multi-step atomicity", () => {
  it("a compound whose second clause fails at build time leaves the doc untouched", () => {
    const doc = noLeadDoc();
    const store = new ProjectStore(doc);
    const route = routeIntentText("set tempo to 120 and rename the lead to sub", store.getDoc());
    expect(route.kind).toBe("compound");
    if (route.kind !== "compound") return;
    expect(() => applyCompoundIntent(store.getDoc(), route.parts)).toThrow(/nothing to rename/);
    expect(store.getDoc().bpm).toBe(doc.bpm); // the FIRST clause did not half-apply
    expect(store.getDoc()).toBe(doc);
  });
});

describe("E2E audit2 parameter bounds (parse → clamp → command)", () => {
  it("pan clamps to ±1, master gain to 1.5, bpm to 20..300", () => {
    const store = new ProjectStore(testDoc());
    const cases: Array<[string, (doc: ProjectDocument) => unknown, unknown]> = [
      ["pan the bass 150% left", (doc) => instrumentTracks(doc).find((t) => /bass|808/i.test(t.name))?.pan, -1],
      ["boost the mix by 400 db", (doc) => doc.master?.masterGain, 1.5],
      ["set tempo to 999", (doc) => doc.bpm, 300],
      ["set tempo to 5", (doc) => doc.bpm, 20],
    ];
    for (const [text, read, expected] of cases) {
      const route = routeIntentText(text, store.getDoc());
      expect(route.kind, text).toBe("exact");
      if (route.kind !== "exact") continue;
      store.execute(applyExactIntentCommand(store.getDoc(), route.plan));
      expect(read(store.getDoc()), text).toBe(expected);
      store.undo();
    }
  });
});

describe("E2E audit2 pinned fallback behaviors (documented, non-destructive)", () => {
  it("unresolvable-target verbs fall to GENERATION — never a guessed mutation", () => {
    expect(routeIntentText("mute the whales", testDoc()).kind).toBe("pattern");
    expect(routeIntentText("delete everything", testDoc()).kind).toBe("pattern");
    // 'remove the drums' without the word "track" is not a track delete
    expect(routeIntentText("remove the drums", testDoc()).kind).toBe("pattern");
  });

  it("track deletes keep requiring the word 'track' plus a resolvable family", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("delete the bass track", store.getDoc());
    expect(route.kind).toBe("exact");
    if (route.kind !== "exact") return;
    store.execute(applyExactIntentCommand(store.getDoc(), route.plan));
    expect(
      instrumentTracks(store.getDoc()).some((t) => /bass|808/i.test(t.name) || ["bass", "808"].includes(t.instrument)),
    ).toBe(false);
    store.undo();
    expect(
      instrumentTracks(store.getDoc()).some((t) => /bass|808/i.test(t.name) || ["bass", "808"].includes(t.instrument)),
    ).toBe(true);
  });
});
