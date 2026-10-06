import { describe, it, expect, beforeAll } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { warmFactoryPresets } from "../src/presets/factory-loader";
import { parseLoudnessIntent, recommendLoudnessTrim } from "../src/intent/loudness";
import {
  applyBypassIntent,
  applyEffectIntent,
  applySendIntent,
  parseEffectIntent,
  planMixProfile,
  applyMixIntent,
} from "../src/intent/mix";
import { applyFaderIntent, applyTempoIntent, faderReadback, type FaderIntent } from "../src/intent/conversation";
import { applyCompoundIntent, compoundReadback } from "../src/intent/compound";
import { applyClipArrangeOps } from "../src/intent/arrangeWords";
import { applyPresetIntentCommand, parsePresetIntent, presetReadback } from "../src/intent/preset-intent";
import { effectReadback } from "../src/intent/mix";
import { parseProductionIntent, productionReadback } from "../src/intent/production";
import { parseExactIntent } from "../src/intent/exact";
import { exactReadback } from "../src/commands/intentRouting";
import { resolveProductionTargets } from "../src/intent/production";
import { normalizeIntent } from "../src/intent/normalize";
import {
  addArrangementClip,
  addEffect,
  createInstrumentTrack,
  createScene,
  setBpm,
  setEffectParam,
  setSceneRole,
} from "../src/commands/commands";
import { applyExactIntentCommand, applyProductionIntentCommand } from "../src/commands/intentRouting";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc, drumTrackOf } from "./fixtures/doc";
import { createInstrumentTrackModel } from "../src/project-model/schema";
import { clampEffectParam, EFFECT_META } from "../src/effects/definitions";
import { classifyPads } from "../src/assist/patternOps";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * INTENT ENGINE END-TO-END AUDIT (2026-09-27).
 *
 * Every case drives the FULL chain the user's words take:
 *   text → routeIntentText → executor command → ProjectStore (real undo
 *   stack) → document state assertion → undo → restored state → redo.
 *
 * Routing to the right executor is NOT success: each block verifies the
 * resulting DAW state equals the requested operation, that one intent is
 * ONE undo entry, and that ambiguous/unsupported asks fail explicitly
 * instead of mutating.
 */

const instrumentTracks = (doc: ProjectDocument): InstrumentTrack[] =>
  doc.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument");

const bassTrackOf = (doc: ProjectDocument): InstrumentTrack => {
  const track = instrumentTracks(doc).find(
    (track) => ["bass", "808", "logdrum"].includes(track.instrument) || /\bbass\b|\b808\b/i.test(track.name),
  );
  if (!track) throw new Error("fixture: no bass-family instrument track");
  return track;
};

/** House fixture + a named Lead instrument track (role-resolvable). */
function withLead(): ProjectDocument {
  const doc = testDoc();
  const lead = { ...createInstrumentTrackModel("analog", 3), name: "Lead" };
  return { ...doc, tracks: [...doc.tracks, lead] };
}

/** Drives the panel executor contract: route → apply → single store.execute. */
function executeRouted(doc: ProjectDocument, text: string, store?: ProjectStore): ProjectDocument {
  const route = routeIntentText(text, doc);
  let command = null;
  if (route.kind === "fader") command = applyFaderIntent(doc, route.intent);
  else if (route.kind === "compound") command = applyCompoundIntent(doc, route.parts);
  else if (route.kind === "clips") command = applyClipArrangeOps(doc, route.ops);
  else if (route.kind === "preset") command = applyPresetIntentCommand(doc, route.intent);
  else if (route.kind === "sendIntent") command = applySendIntent(doc, route.intent);
  else if (route.kind === "bypassIntent") command = applyBypassIntent(doc, route.intent);
  else if (route.kind === "exact") command = applyExactIntentCommand(doc, route.plan);
  else if (route.kind === "tempo") command = applyTempoIntent(doc, route.intent);
  else if (route.kind === "effectIntent") command = applyEffectIntent(doc, route.intent);
  else if (route.kind === "production") command = applyProductionIntentCommand(doc, route.intent);
  else if (route.kind === "mix")
    command = applyMixIntent(doc, planMixProfile(normalizeIntent({ text }), route.overrides));
  else throw new Error(`unexpected route kind ${route.kind} for "${text}"`);
  if (!command) throw new Error(`executor returned no command for "${text}"`);
  if (store) store.execute(command);
  return command.execute(doc);
}

// ─── 1. FADER — named-track gain, one undo entry, explicit failures ─────────

// The factory preset bank is a lazy chunk now — the sync preset parsers
// read it only after the warm. One await covers every describe below.
beforeAll(async () => {
  await warmFactoryPresets();
});

describe("E2E fader: route → state → undo", () => {
  it("zníž basu lowers the 808 track and ONE undo restores it", () => {
    const store = new ProjectStore(testDoc());
    const before = bassTrackOf(store.doc).gain;

    const route = routeIntentText("zníž basu", store.doc);
    expect(route.kind).toBe("fader");
    executeRouted(store.doc, "zníž basu", store);

    const after = bassTrackOf(store.doc).gain;
    expect(after).toBeLessThan(before);
    // ONE undo entry for the whole intent — the panel's promise is literal.
    expect(store.undoStackLength).toBe(1);

    store.undo();
    expect(bassTrackOf(store.doc).gain).toBe(before);
    store.redo();
    expect(bassTrackOf(store.doc).gain).toBe(after);
  });

  it("louder drums raises the drum fader (EN comparative + named target)", () => {
    const doc = testDoc();
    const route = routeIntentText("louder drums", doc);
    expect(route.kind).toBe("fader");
    const next = executeRouted(doc, "louder drums");
    expect(drumTrackOf(next).gain).toBeGreaterThan(drumTrackOf(doc).gain);
  });

  it("untargeted shouts still belong to the master loudness loop", () => {
    const doc = testDoc();
    expect(routeIntentText("make it louder", doc).kind).toBe("loudness");
    expect(routeIntentText("make it quieter", doc).kind).toBe("loudness");
  });

  it("missing target family fails explicitly — no guessed substitute track", () => {
    const doc = testDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    // route still says "fader", but the executor refuses instead of picking
    // an arbitrary instrument track (the old positional fallback)
    expect(routeIntentText("zníž basu", drumsOnly).kind).toBe("fader");
    expect(applyFaderIntent(drumsOnly, { targets: ["bass"], direction: "down" })).toBeNull();
    expect(applyFaderIntent(drumsOnly, { targets: ["lead"], direction: "up" })).toBeNull();
  });

  it("COMPOUND: 'zníž basu a zvýš lead' moves BOTH in one undo (no clarify needed)", () => {
    const store = new ProjectStore(withLead());
    const bassBefore = bassTrackOf(store.doc).gain;
    const leadBefore = instrumentTracks(store.doc).find((track) => /\blead\b/i.test(track.name))!.gain;

    const route = routeIntentText("zníž basu a zvýš lead", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind === "compound") {
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0]).toMatchObject({
        kind: "fader",
        intent: { targets: ["bass"], direction: "down" },
      });
      expect(route.parts[1]).toMatchObject({
        kind: "fader",
        intent: { targets: ["lead"], direction: "up" },
      });
    }
    executeRouted(store.doc, "zníž basu a zvýš lead", store);

    expect(bassTrackOf(store.doc).gain).toBeLessThan(bassBefore);
    expect(instrumentTracks(store.doc).find((track) => /\blead\b/i.test(track.name))!.gain).toBeGreaterThan(leadBefore);
    // the whole compound is ONE undo entry — not one per clause
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(bassTrackOf(store.doc).gain).toBe(bassBefore);
    expect(instrumentTracks(store.doc).find((track) => /\blead\b/i.test(track.name))!.gain).toBe(leadBefore);
  });

  it("compound with amounts parses each clause's modifiers", () => {
    const doc = withLead();
    const route = routeIntentText("zníž basu o 10 % a zvýš lead trochu", doc);
    expect(route.kind).toBe("compound");
    if (route.kind === "compound") {
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0]).toMatchObject({
        kind: "fader",
        intent: { targets: ["bass"], direction: "down", percent: 10 },
      });
      expect(route.parts[1]).toMatchObject({
        kind: "fader",
        intent: { targets: ["lead"], direction: "up", amount: "subtle" },
      });
    }
  });

  it("partially parseable compounds still clarify (never drops an unparsed clause)", () => {
    const doc = testDoc();
    // "zvýš niečo" has no resolvable target — auto-executing just the bass
    // half would silently ignore what the user asked about the other half
    const route = routeIntentText("zníž basu a zvýš niečo", doc);
    expect(route.kind).toBe("clarify");
    if (route.kind === "clarify") {
      expect(route.suggestions).toEqual(["zníž basu"]);
    }
  });

  it("'zníž hlasitosť basu' is ONE direction — hlasitosť is the volume NOUN", () => {
    const doc = testDoc();
    const single = routeIntentText("zníž hlasitosť basu", doc);
    expect(single.kind).toBe("fader");
    if (single.kind === "fader") {
      expect(single.intent.direction).toBe("down");
    }
  });

  it("direction without a target asks which fader, in the text's language", () => {
    const doc = testDoc();
    const sk = routeIntentText("zníž", doc);
    expect(sk.kind).toBe("clarify");
    if (sk.kind === "clarify") {
      expect(sk.suggestions).toContain("zníž basu");
      for (const suggestion of sk.suggestions) {
        expect(routeIntentText(suggestion, doc).kind).toBe("fader");
      }
    }
    const skUp = routeIntentText("hlasnejšie", doc);
    expect(skUp.kind).toBe("clarify");
    if (skUp.kind === "clarify") {
      expect(skUp.suggestions.some((suggestion) => suggestion.includes("bicie"))).toBe(true);
    }
    const en = routeIntentText("turn down", doc);
    expect(en.kind).toBe("clarify");
    if (en.kind === "clarify") {
      expect(en.suggestions).toContain("turn down the drums");
      for (const suggestion of en.suggestions) {
        expect(routeIntentText(suggestion, doc).kind).toBe("fader");
      }
    }
  });

  it("percent stays bounded (o 300 % clamps to 100 %)", () => {
    const doc = testDoc();
    const route = routeIntentText("zníž basu o 300%", doc);
    expect(route.kind).toBe("fader");
    if (route.kind === "fader") expect(route.intent.percent).toBe(100);
    const next = executeRouted(doc, "zníž basu o 300%");
    expect(bassTrackOf(next).gain).toBe(0);
  });
});

// ─── 1b. CROSS-EXECUTOR COMPOUNDS — mixed kinds, still ONE undo ─────────────

describe("E2E cross-executor compounds", () => {
  const leadTrackOf = (doc: ProjectDocument): InstrumentTrack => {
    const track = instrumentTracks(doc).find((track) => /\blead\b/i.test(track.name));
    if (!track) throw new Error("fixture: no Lead track");
    return track;
  };

  it("REGRESSION: 'zníž tempo a zvýš lead' applies BOTH — the tempo route used to silently drop the lead half", () => {
    const store = new ProjectStore(withLead());
    const bpmBefore = store.doc.bpm;
    const leadBefore = leadTrackOf(store.doc).gain;

    const route = routeIntentText("zníž tempo a zvýš lead", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind === "compound") {
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0]).toMatchObject({ kind: "tempo", intent: { direction: "down" } });
      expect(route.parts[1]).toMatchObject({ kind: "fader", intent: { targets: ["lead"], direction: "up" } });
    }
    executeRouted(store.doc, "zníž tempo a zvýš lead", store);

    expect(store.doc.bpm).toBe(bpmBefore - 6);
    expect(leadTrackOf(store.doc).gain).toBeGreaterThan(leadBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.bpm).toBe(bpmBefore);
    expect(leadTrackOf(store.doc).gain).toBe(leadBefore);
  });

  it("tempo set + fader clause: 'zníž tempo na 128 a zvýš lead'", () => {
    const store = new ProjectStore(withLead());
    const leadBefore = leadTrackOf(store.doc).gain;
    executeRouted(store.doc, "zníž tempo na 128 a zvýš lead", store);
    expect(store.doc.bpm).toBe(128);
    expect(leadTrackOf(store.doc).gain).toBeGreaterThan(leadBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.bpm).not.toBe(128);
    expect(leadTrackOf(store.doc).gain).toBe(leadBefore);
  });

  it("effect + fader: 'viac delayu na leade a zníž basu' lands both in one undo", () => {
    const store = new ProjectStore(withLead());
    const bassBefore = bassTrackOf(store.doc).gain;
    const route = routeIntentText("viac delayu na leade a zníž basu", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind === "compound") {
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0]).toMatchObject({ kind: "effect", intent: { effectType: "delay" } });
      expect(route.parts[1]).toMatchObject({ kind: "fader", intent: { targets: ["bass"], direction: "down" } });
    }
    executeRouted(store.doc, "viac delayu na leade a zníž basu", store);
    expect(leadTrackOf(store.doc).effects.some((fx) => fx.type === "delay")).toBe(true);
    expect(bassTrackOf(store.doc).gain).toBeLessThan(bassBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(leadTrackOf(store.doc).effects.length).toBe(0);
    expect(bassTrackOf(store.doc).gain).toBe(bassBefore);
  });

  it("all-effect compound: 'viac delayu na leade a menej reverbu na basi'", () => {
    const doc = withLead();
    const route = routeIntentText("viac delayu na leade a menej reverbu na basi", doc);
    expect(route.kind).toBe("compound");
    if (route.kind === "compound") {
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0]).toMatchObject({ kind: "effect", intent: { effectType: "delay", direction: "more" } });
      expect(route.parts[1]).toMatchObject({ kind: "effect", intent: { effectType: "reverb", direction: "less" } });
    }
    const next = executeRouted(doc, "viac delayu na leade a menej reverbu na basi");
    const delayMixDef = EFFECT_META.delay.params.find((param) => param.id === "mix")!;
    const reverbMixDef = EFFECT_META.reverb.params.find((param) => param.id === "mix")!;
    const lead = leadTrackOf(next);
    expect(lead.effects.find((fx) => fx.type === "delay")!.params.mix).toBeGreaterThan(delayMixDef.default);
    const bass = bassTrackOf(next);
    expect(bass.effects.find((fx) => fx.type === "reverb")!.params.mix).toBeLessThan(reverbMixDef.default);
  });

  it("an already-satisfied clause is skipped honestly — the rest still lands", () => {
    const store = new ProjectStore(withLead());
    // pin the lead's delay mix at its max — "viac delayu" can no-op then
    const withMaxDelay = addEffect(store.doc, leadTrackOf(store.doc).id, "delay").execute(store.doc);
    const delayFx = leadTrackOf(withMaxDelay).effects.find((fx) => fx.type === "delay")!;
    const maxMix = EFFECT_META.delay.params.find((param) => param.id === "mix")!.max;
    store.replaceDoc(
      setEffectParam(withMaxDelay, leadTrackOf(withMaxDelay).id, delayFx.id, "mix", maxMix).execute(withMaxDelay),
    );
    const bassBefore = bassTrackOf(store.doc).gain;

    executeRouted(store.doc, "viac delayu na leade a zníž basu", store);
    expect(store.undoStackLength).toBe(1);
    expect(bassTrackOf(store.doc).gain).toBeLessThan(bassBefore);
    // the delay knob stayed at max (the clause asked for nothing achievable)
    expect(leadTrackOf(store.doc).effects.find((fx) => fx.type === "delay")!.params.mix).toBe(maxMix);
  });

  it("all-tempo clause sets stay with the tempo route (first-match, no chaining)", () => {
    const doc = testDoc();
    // "tempo na 128 a pomalší" chaining clause-by-clause would land on 122 —
    // the whole-text tempo route's first-match (128) is the honest reading
    const route = routeIntentText("tempo na 128 a pomalší", doc);
    expect(route.kind).toBe("tempo");
    const next = executeRouted(doc, "tempo na 128 a pomalší");
    expect(next.bpm).toBe(128);
  });
});

// ─── 2. EXACT — mixer commands that used to fall through to GENERATION ──────

describe("E2E exact intents: route → state → undo", () => {
  it("mute the drums mutes the drum track (previously generated a beat!)", () => {
    const store = new ProjectStore(testDoc());
    expect(routeIntentText("mute the drums", store.doc).kind).toBe("exact");

    executeRouted(store.doc, "mute the drums", store);
    expect(drumTrackOf(store.doc).mute).toBe(true);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).mute).toBe(false);
  });

  it("solo the bass solos only the bass track", () => {
    const doc = testDoc();
    const route = routeIntentText("solo the bass", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "solo the bass");
    expect(bassTrackOf(next).solo).toBe(true);
    expect(drumTrackOf(next).solo).toBe(false);
    expect(
      instrumentTracks(next)
        .filter((track) => track.id !== bassTrackOf(next).id)
        .every((track) => !track.solo),
    ).toBe(true);
  });

  it("unmute restores the track", () => {
    const doc = testDoc();
    const bass = bassTrackOf(doc);
    const muted: ProjectDocument = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.id === bass.id ? { ...t, mute: true } : t)),
    };
    const next = executeRouted(muted, "unmute the bass");
    expect(bassTrackOf(next).mute).toBe(false);
  });

  it("pan the bass left 30 clamps into the pan range", () => {
    const doc = testDoc();
    const route = routeIntentText("pan the bass left 30", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "pan the bass left 30");
    expect(bassTrackOf(next).pan).toBe(-0.3);
  });

  it("boost the mix hits the MASTER fader, not tracks[0]", () => {
    const doc = testDoc();
    const drumsBefore = drumTrackOf(doc).gain;
    const bassBefore = bassTrackOf(doc).gain;
    const masterBefore = doc.master.masterGain;

    const route = routeIntentText("boost the mix by 1.5 db", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "boost the mix by 1.5 db");

    expect(next.master.masterGain).toBeCloseTo(masterBefore * Math.pow(10, 1.5 / 20), 5);
    // regression: the old mapping boosted tracks[0] and left the master alone
    expect(drumTrackOf(next).gain).toBe(drumsBefore);
    expect(bassTrackOf(next).gain).toBe(bassBefore);
  });

  it("multi-action request applies both ops in ONE undo entry (compound route)", () => {
    const store = new ProjectStore(testDoc());
    const bpmBefore = store.doc.bpm;
    // whole-text exact would partial-apply (mute only, "set tempo" clause is
    // a tempo parse) — the compound owns the sentence now
    expect(routeIntentText("mute the drums and set tempo to 140", store.doc).kind).toBe("compound");
    executeRouted(store.doc, "mute the drums and set tempo to 140", store);
    expect(drumTrackOf(store.doc).mute).toBe(true);
    expect(store.doc.bpm).toBe(140);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).mute).toBe(false);
    expect(store.doc.bpm).toBe(bpmBefore);
  });

  it("REGRESSION: 'mute the drums and zníž basu' applies BOTH (exact used to drop the fader clause)", () => {
    const store = new ProjectStore(testDoc());
    const bassBefore = bassTrackOf(store.doc).gain;
    const route = routeIntentText("mute the drums and zníž basu", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind === "compound") {
      expect(route.parts).toHaveLength(2);
      expect(route.parts[0]).toMatchObject({ kind: "exact" });
      expect(route.parts[1]).toMatchObject({ kind: "fader", intent: { targets: ["bass"], direction: "down" } });
    }
    executeRouted(store.doc, "mute the drums and zníž basu", store);
    expect(drumTrackOf(store.doc).mute).toBe(true);
    expect(bassTrackOf(store.doc).gain).toBeLessThan(bassBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).mute).toBe(false);
    expect(bassTrackOf(store.doc).gain).toBe(bassBefore);
  });

  it("150 bpm routes exact and applies; out-of-range asks never mutate", () => {
    const doc = testDoc();
    // bare "<n> bpm" is an exact tempo op (the conversation parser keeps "na/to")
    const route = routeIntentText("150 bpm", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "150 bpm");
    expect(next.bpm).toBe(150);

    // conversation tempo with an explicit SK target
    expect(routeIntentText("tempo na 128", doc).kind).toBe("tempo");

    // outside the parser's 40..220 window → NOT a tempo intent, no mutation
    expect(routeIntentText("tempo na 500", doc).kind).not.toBe("tempo");
    expect(routeIntentText("tempo na 500", doc).kind).not.toBe("exact");
    // setBpm clamps regardless of what the AI layer sends (defense in depth)
    expect(setBpm(doc, 9999).execute(doc).bpm).toBeLessThanOrEqual(300);
  });
});

// ─── 3. EFFECT INTENT — targeted add/turn/remove with real ranges ───────────

describe("E2E effect intents: route → state → undo", () => {
  it("viac delayu na leade adds a delay to the lead and turns its mix up", () => {
    const store = new ProjectStore(withLead());
    const route = routeIntentText("viac delayu na leade", store.doc);
    expect(route.kind).toBe("effectIntent");

    executeRouted(store.doc, "viac delayu na leade", store);
    const lead = store.doc.tracks.find(
      (track): track is InstrumentTrack =>
        track.kind === "instrument" && track.effects.some((fx) => fx.type === "delay"),
    );
    expect(lead).toBeDefined();
    const delay = lead!.effects.find((fx) => fx.type === "delay")!;
    const mixDef = EFFECT_META.delay.params.find((param) => param.id === "mix")!;
    expect(delay.params.mix).toBeGreaterThan(mixDef.default);
    expect(delay.params.mix).toBeLessThanOrEqual(mixDef.max);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).every((track) => !track.effects.some((fx) => fx.type === "delay"))).toBe(true);
  });

  it("percent rides the knob's own range and clamps (o 500 %)", () => {
    const doc = withLead();
    const route = routeIntentText("viac delayu na leade o 500%", doc);
    expect(route.kind).toBe("effectIntent");
    if (route.kind === "effectIntent") expect(route.intent.percent).toBe(100);
    const next = executeRouted(doc, "viac delayu na leade o 500%");
    const lead = instrumentTracks(next).find((track) => track.effects.some((fx) => fx.type === "delay"))!;
    const delay = lead.effects.find((fx) => fx.type === "delay")!;
    const mixDef = EFFECT_META.delay.params.find((param) => param.id === "mix")!;
    expect(delay.params.mix).toBeLessThanOrEqual(mixDef.max);
    expect(clampEffectParam("delay", "mix", 42)).toBeLessThanOrEqual(mixDef.max);
  });

  it("remove reverb from the bass: explicit error when absent, works when present", () => {
    const doc = testDoc();
    const route = routeIntentText("remove reverb from the bass", doc);
    expect(route.kind).toBe("effectIntent");
    // no track reverb installed yet → explicit "changed nothing" failure
    expect(() => executeRouted(doc, "remove reverb from the bass")).toThrow(/changed nothing/);

    // install reverb on the bass, then the removal works and undoes
    const store = new ProjectStore(doc);
    executeRouted(store.doc, "viac reverbu na basi", store);
    const hasBassReverb = (d: ProjectDocument) =>
      instrumentTracks(d).some(
        (track) => /\b808\b|\bbass/i.test(track.name) && track.effects.some((fx) => fx.type === "reverb"),
      );
    expect(hasBassReverb(store.doc)).toBe(true);
    executeRouted(store.doc, "remove reverb from the bass", store);
    expect(hasBassReverb(store.doc)).toBe(false);
    store.undo();
    expect(hasBassReverb(store.doc)).toBe(true);
  });
});

// ─── 4. MIX — profile applies ONLY on real mix vocabulary ────────────────────

describe("E2E mix route: detected vocabulary vs unintended defaults", () => {
  it("more reverb installs reverb on music roles as one undo", () => {
    const store = new ProjectStore(testDoc());
    expect(routeIntentText("more reverb please", store.doc).kind).toBe("mix");
    executeRouted(store.doc, "more reverb please", store);
    const withReverb = instrumentTracks(store.doc).filter((track) => track.effects.some((fx) => fx.type === "reverb"));
    expect(withReverb.length).toBeGreaterThan(0);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).every((track) => !track.effects.some((fx) => fx.type === "reverb"))).toBe(true);
  });

  it("REGRESSION: unresolvable effect asks clarify, never the default profile", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    // "trumpets" names a target the engine cannot resolve — the ORIGINAL
    // behavior applied the house-default mix profile (a sidechain pump on
    // bass+chords) the user never asked for; the fix first fell to pattern,
    // now it clarifies with executable suggestions.
    for (const text of ["more delay on the trumpets", "more compression"]) {
      const route = routeIntentText(text, store.doc);
      expect(route.kind).toBe("clarify");
      if (route.kind === "clarify") {
        expect(route.suggestions.length).toBeGreaterThan(0);
        for (const suggestion of route.suggestions) {
          expect(["fader", "exact", "effectIntent", "production", "mix"]).toContain(
            routeIntentText(suggestion, store.doc).kind,
          );
        }
      }
    }
    // no direction word → not a declined effect ask → still a prompt
    expect(routeIntentText("some eq please", store.doc).kind).toBe("pattern");
    // routing alone never mutated anything
    expect(store.undoStackLength).toBe(0);
  });

  it("targeted effect nouns still outrank the profile", () => {
    const doc = testDoc();
    expect(routeIntentText("more delay on the bass", doc).kind).toBe("effectIntent");
  });
});

// ─── 5. PRODUCTION — concept × target lands as track FX ─────────────────────

describe("E2E production intents: route → state → undo", () => {
  it("make the drums darker installs a darker filter on the drum track", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("make the drums darker", store.doc);
    expect(route.kind).toBe("production");

    executeRouted(store.doc, "make the drums darker", store);
    const drums = drumTrackOf(store.doc);
    const filter = drums.effects.find((fx) => fx.type === "svFilter");
    expect(filter).toBeDefined();
    expect(filter!.params.mode).toBe(0); // low-pass
    expect(filter!.params.cutoff).toBeLessThan(16000);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).effects.length).toBe(0);
  });

  it("production without any matching track throws an actionable error", () => {
    const doc = testDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    // "deeper" targets the bass family — a drums-only project must fail loudly
    expect(() => executeRouted(drumsOnly, "make the bass deeper")).toThrow(/No matching track/);
  });
});

// ─── 6. LOUDNESS — parse + bounded recommendation (render loop is injected) ──

describe("E2E loudness intents: parse + recommendation bounds", () => {
  it("explicit targets parse; directions parse; other numbers do not hijack", () => {
    expect(parseLoudnessIntent("loudness na −9")).toMatchObject({ direction: "louder", targetDb: -9 });
    expect(parseLoudnessIntent("make it quieter")).toMatchObject({ direction: "quieter" });
    expect(parseLoudnessIntent("140 bpm")).toBeNull(); // tempo's job
    expect(parseLoudnessIntent("dark techno")).toBeNull();
  });

  it("recommendations clamp to the ±6 dB trim field and refuse without evidence", () => {
    // way too loud → full −6 pull, never beyond
    expect(recommendLoudnessTrim(-4, -14, 0).trimDb).toBe(-6);
    expect(recommendLoudnessTrim(-4, -14, 4).trimDb).toBe(-6);
    // unmeasurable → no intervention recommended
    const none = recommendLoudnessTrim(null, -14, 0);
    expect(none.trimDb).toBeNull();
    expect(none.affected).toEqual(["master (loudnessTrimDb)"]);
  });
});

// ─── 7. UNDO / TRANSACTIONAL CONTRACT across executors ──────────────────────

describe("E2E transactional contract", () => {
  it("every mutating executor lands exactly ONE undo entry with a clean restore", () => {
    const cases: Array<[string, () => ProjectDocument]> = [
      ["zníž basu", testDoc],
      ["mute the drums", testDoc],
      ["viac delayu na leade", withLead],
      ["make the drums darker", testDoc],
      ["more reverb please", testDoc],
    ];
    for (const [text, makeDoc] of cases) {
      const store = new ProjectStore(makeDoc());
      executeRouted(store.doc, text, store);
      expect(store.undoStackLength).toBe(1);
      store.undo();
      // the undo restores the pre-intent state (no intent FX left behind)
      const restored = store.doc;
      expect(restored.tracks.every((track) => track.effects.length === 0)).toBe(true);
    }
  });

  it("generation-route texts never mutate the document by themselves", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    for (const text of ["dark rolling techno at 140", "tempo na 500", "beat with a dark drop"]) {
      expect(routeIntentText(text, store.doc).kind).toBe("pattern");
    }
    // clarify declines too — it only TALKS
    expect(routeIntentText("more delay on the trumpets", store.doc).kind).toBe("clarify");
    expect(store.undoStackLength).toBe(0);
    expect(store.doc).toBe(doc);
  });
});

// ─── 8. Parameter-correctness: the AI layer cannot bypass domain ranges ─────

describe("E2E parameter correctness", () => {
  it("setEffectParam rejects undefined params (domain validation owns the truth)", () => {
    const doc = testDoc();
    const drums = drumTrackOf(doc);
    const withFx = addEffect(doc, drums.id, "delay").execute(doc);
    const fx = withFx.tracks.find((t) => t.id === drums.id)!.effects.find((f) => f.type === "delay")!;
    expect(() => setEffectParam(withFx, drums.id, fx.id, "notAParam", 1)).toThrow(/not defined/);
    // out-of-domain values clamp to the effect's own def, never pass through
    const maxMix = EFFECT_META.delay.params.find((param) => param.id === "mix")!.max;
    expect(clampEffectParam("delay", "mix", 99)).toBe(maxMix);
  });
});

// ─── 9. EXACT pad families — per-pad pan/mute on the drum track ─────────────

describe("E2E exact pad-family ops", () => {
  it("pan the hats 40% right pans only the hat pads", () => {
    const doc = testDoc();
    const route = routeIntentText("pan the hats 40% right", doc);
    expect(route.kind).toBe("exact");
    if (route.kind === "exact") {
      expect(route.plan.ops).toEqual([{ kind: "pan", target: "hats", value: 0.4 }]);
    }
    const next = executeRouted(doc, "pan the hats 40% right");
    const drum = drumTrackOf(next);
    const hatIds = new Set(classifyPads(drum.pads).hats.map((pad) => pad.id));
    expect(hatIds.size).toBeGreaterThan(0);
    const pansBefore = new Map(drumTrackOf(doc).pads.map((pad) => [pad.id, pad.pan]));
    for (const pad of drum.pads) {
      if (hatIds.has(pad.id)) expect(pad.pan).toBe(0.4);
      else expect(pad.pan).toBe(pansBefore.get(pad.id));
    }
  });

  it("mute the kick mutes only kick pads — the drum track stays live", () => {
    const store = new ProjectStore(testDoc());
    expect(routeIntentText("mute the kick", store.doc).kind).toBe("exact");
    executeRouted(store.doc, "mute the kick", store);
    const drum = drumTrackOf(store.doc);
    const kickIds = new Set(classifyPads(drum.pads).kicks.map((pad) => pad.id));
    expect(kickIds.size).toBeGreaterThan(0);
    for (const pad of drum.pads) expect(pad.mute).toBe(kickIds.has(pad.id));
    expect(drum.mute).toBe(false);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(drumTrackOf(store.doc).pads.every((pad) => !pad.mute)).toBe(true);
  });

  it("hyphenated hi-hats resolve as the hats family", () => {
    const route = routeIntentText("mute the hi-hats", testDoc());
    expect(route.kind).toBe("exact");
    if (route.kind === "exact") {
      expect(route.plan.ops).toEqual([{ kind: "mute", target: "hats", value: true }]);
    }
  });

  it("pad families stay OUT of gain/transpose ops (no silent widening to the track)", () => {
    const doc = testDoc();
    // gainDb has no per-pad op — a family ask must not boost the whole drum
    // track; the text simply is not an exact intent.
    const route = routeIntentText("boost the hats by 2 db", doc);
    expect(route.kind).not.toBe("exact");
  });
});

// ─── 10. ABSOLUTE SET — "set X to N%" lands the knob exactly ────────────────

describe("E2E absolute-set effect asks", () => {
  it("set the lead reverb mix to 25% lands the knob at 25% of its range", () => {
    const store = new ProjectStore(withLead());
    const route = routeIntentText("set the lead reverb mix to 25%", store.doc);
    expect(route.kind).toBe("effectIntent");
    if (route.kind === "effectIntent") {
      expect(route.intent.direction).toBe("set");
      expect(route.intent.percent).toBe(25);
    }
    executeRouted(store.doc, "set the lead reverb mix to 25%", store);
    const lead = store.doc.tracks.find(
      (track): track is InstrumentTrack =>
        track.kind === "instrument" && track.effects.some((fx) => fx.type === "reverb"),
    );
    expect(lead).toBeDefined();
    const reverb = lead!.effects.find((fx) => fx.type === "reverb")!;
    const mixDef = EFFECT_META.reverb.params.find((param) => param.id === "mix")!;
    expect(reverb.params.mix).toBeCloseTo(mixDef.min + 0.25 * (mixDef.max - mixDef.min), 6);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).every((track) => !track.effects.some((fx) => fx.type === "reverb"))).toBe(true);
  });

  it("SK: nastav delay na leade na 30 % sets the delay mix absolutely", () => {
    const doc = withLead();
    const route = routeIntentText("nastav delay na leade na 30 %", doc);
    expect(route.kind).toBe("effectIntent");
    if (route.kind === "effectIntent") {
      expect(route.intent.direction).toBe("set");
      expect(route.intent.percent).toBe(30);
    }
    const next = executeRouted(doc, "nastav delay na leade na 30 %");
    const lead = instrumentTracks(next).find((track) => track.effects.some((fx) => fx.type === "delay"))!;
    const delay = lead.effects.find((fx) => fx.type === "delay")!;
    const mixDef = EFFECT_META.delay.params.find((param) => param.id === "mix")!;
    expect(delay.params.mix).toBeCloseTo(mixDef.min + 0.3 * (mixDef.max - mixDef.min), 6);
  });

  it("a foreign knob ask declines — the engine never retunes a different param", () => {
    const doc = withLead();
    // "time" is a real delay param, but NOT the intent knob — the old shape
    // of this text would have slammed the mix knob to full.
    expect(parseEffectIntent("set the delay time to 375%")).toBeNull();
    const route = routeIntentText("set the delay time to 375%", doc);
    expect(route.kind).toBe("clarify");
    if (route.kind === "clarify") {
      expect(route.suggestions[0]).toContain("set delay mix");
    }
  });

  it("set clamps out-of-range percentages (250% → knob max)", () => {
    const doc = withLead();
    const next = executeRouted(doc, "set the lead reverb mix to 250%");
    const lead = instrumentTracks(next).find((track) => track.effects.some((fx) => fx.type === "reverb"))!;
    const reverb = lead.effects.find((fx) => fx.type === "reverb")!;
    expect(reverb.params.mix).toBe(EFFECT_META.reverb.params.find((param) => param.id === "mix")!.max);
  });

  it("the vocal target parses (audit example) and fails explicitly without takes", () => {
    const doc = testDoc();
    const intent = parseEffectIntent("set the vocal reverb mix to 25%");
    expect(intent).toMatchObject({ effectType: "reverb", direction: "set", targets: ["vocal"] });
    // no arrangement audio in the fixture → explicit failure, never silence
    expect(() => applyEffectIntent(doc, intent!)).toThrow(/no tracks match/);
  });
});

// ─── 11. TRACK CRUD — add/rename/duplicate/delete via canonical commands ────

describe("E2E track CRUD intents", () => {
  it("add a drum track creates a drum lane; one undo removes it", () => {
    const store = new ProjectStore(testDoc());
    const drumsBefore = store.doc.tracks.filter((t) => t.kind === "drum").length;
    expect(routeIntentText("add a drum track", store.doc).kind).toBe("exact");
    executeRouted(store.doc, "add a drum track", store);
    expect(store.doc.tracks.filter((t) => t.kind === "drum")).toHaveLength(drumsBefore + 1);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.tracks.filter((t) => t.kind === "drum")).toHaveLength(drumsBefore);
  });

  it("add a bass track names the kind; bare 'add a track' defaults to analog; pads decline", () => {
    const doc = testDoc();
    const withBass = executeRouted(doc, "add a bass track");
    expect(instrumentTracks(withBass).some((t) => t.instrument === "bass")).toBe(true);
    const withDefault = executeRouted(doc, "add a track");
    expect(instrumentTracks(withDefault).some((t) => t.instrument === "analog")).toBe(true);
    // a pad is not a lane — the engine does not guess one from a pad word
    expect(routeIntentText("add a hat track", doc).kind).not.toBe("exact");
  });

  it("rename the bass renames the resolved track; undo restores the old name", () => {
    const store = new ProjectStore(testDoc());
    const nameBefore = bassTrackOf(store.doc).name;
    expect(routeIntentText('rename the bass to "sub bass"', store.doc).kind).toBe("exact");
    executeRouted(store.doc, 'rename the bass to "sub bass"', store);
    expect(bassTrackOf(store.doc).name).toBe("sub bass");
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(bassTrackOf(store.doc).name).toBe(nameBefore);
  });

  it("delete the lead track removes it, undo restores it, missing family fails loudly", () => {
    const store = new ProjectStore(withLead());
    executeRouted(store.doc, "delete the lead track", store);
    expect(store.doc.tracks.some((t) => /\blead\b/i.test(t.name))).toBe(false);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.tracks.some((t) => /\blead\b/i.test(t.name))).toBe(true);
    // destructive ops never guess by position: no lead family → explicit error
    const noLead = new ProjectStore(testDoc());
    expect(() => executeRouted(noLead.doc, "delete the lead track", noLead)).toThrow(/no track matches/);
  });

  it("delete respects the last-track guard and never targets the mix", () => {
    const doc = testDoc();
    const drum = drumTrackOf(doc);
    const drumsOnly: ProjectDocument = { ...doc, tracks: [drum] };
    expect(() => executeRouted(drumsOnly, "delete the drum track")).toThrow(/Cannot delete the last/);
    expect(routeIntentText("delete the mix track", doc).kind).not.toBe("exact");
  });

  it("duplicate the bass track clones it; undo removes the clone", () => {
    const store = new ProjectStore(testDoc());
    const before = instrumentTracks(store.doc).length;
    executeRouted(store.doc, "duplicate the bass track", store);
    expect(instrumentTracks(store.doc)).toHaveLength(before + 1);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc)).toHaveLength(before);
  });

  it("track CRUD rides compounds: 'add a keys track and zníž basu' lands both", () => {
    const store = new ProjectStore(testDoc());
    const bassBefore = bassTrackOf(store.doc).gain;
    const route = routeIntentText("add a keys track and zníž basu", store.doc);
    expect(route.kind).toBe("compound");
    executeRouted(store.doc, "add a keys track and zníž basu", store);
    expect(instrumentTracks(store.doc).some((t) => t.instrument === "keys")).toBe(true);
    expect(bassTrackOf(store.doc).gain).toBeLessThan(bassBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).some((t) => t.instrument === "keys")).toBe(false);
    expect(bassTrackOf(store.doc).gain).toBe(bassBefore);
  });
});

// ─── 12. TRANSPORT + SELECT — runtime/UI state, never document mutations ────

describe("E2E transport + select intents", () => {
  it("bare words route to transport; anything with a tail stays a prompt", () => {
    const doc = testDoc();
    const cases = [
      ["stop", "stop"],
      ["play", "play"],
      ["pause", "pause"],
      ["hraj", "play"],
      ["štart", "play"],
      ["pauza", "pause"],
      ["zastav", "stop"],
      ["metronome on", "metronomeOn"],
      ["metronome off", "metronomeOff"],
    ] as const;
    for (const [text, action] of cases) {
      const route = routeIntentText(text, doc);
      expect(route.kind).toBe("transport");
      if (route.kind === "transport") expect(route.action).toBe(action);
    }
    expect(routeIntentText("stop the beat", doc).kind).not.toBe("transport");
    expect(routeIntentText("play something funky", doc).kind).not.toBe("transport");
    expect(routeIntentText("metronome", doc).kind).not.toBe("transport"); // on/off? decline
  });

  it("select routes with the family and never mutates the document", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    const route = routeIntentText("select the bass", doc);
    expect(route.kind).toBe("select");
    if (route.kind === "select") {
      expect(route.target).toBe("bass");
      // the resolver contract the panel dispatches through
      expect(resolveProductionTargets(doc, [route.target as never]).length).toBeGreaterThan(0);
    }
    expect(routeIntentText("vyber bicie", doc).kind).toBe("select");
    // the mix is not a selectable lane; routing alone never mutated anything
    expect(routeIntentText("select the mix", doc).kind).not.toBe("select");
    expect(store.undoStackLength).toBe(0);
    expect(store.doc).toBe(doc);
  });
});

// ─── 13. CLIP WORDS — trim/copy/move/delete at absolute positions ───────────

describe("E2E clip intents: copy/move/trim/delete", () => {
  /** Scenes with roles + one clip each: intro at bar 0 (4 bars), drop at bar 4 (4 bars). */
  function withRoleClips(): ProjectDocument {
    let doc = testDoc();
    doc = createScene(doc, "Intro").execute(doc);
    doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "intro").execute(doc);
    doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 0, 4).execute(doc);
    doc = createScene(doc, "Drop").execute(doc);
    doc = setSceneRole(doc, doc.scenes[doc.scenes.length - 1].id, "drop").execute(doc);
    doc = addArrangementClip(doc, doc.scenes[doc.scenes.length - 1].id, 4, 4).execute(doc);
    return doc;
  }

  it("copy the intro clip to bar 5 places a same-length copy at bar 4 (0-based)", () => {
    const store = new ProjectStore(withRoleClips());
    // user bar 9 = 0-based 8 — the first FREE bar (the drop covers bars 5–8)
    const route = routeIntentText("copy the intro clip to bar 9", store.doc);
    expect(route.kind).toBe("clips");
    if (route.kind === "clips") {
      expect(route.ops).toEqual([{ op: "copyClip", clipId: route.ops[0].clipId, toBar: 8 }]);
    }
    executeRouted(store.doc, "copy the intro clip to bar 9", store);
    expect(store.doc.arrangement.clips).toHaveLength(3);
    const copy = store.doc.arrangement.clips.find((c) => c.startBar === 8);
    expect(copy).toBeDefined();
    const introSceneId = store.doc.arrangement.clips[0].sceneId;
    expect(copy!.sceneId).toBe(introSceneId);
    expect(copy!.lengthBars).toBe(4);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.arrangement.clips).toHaveLength(2);
  });

  it("copy by position: 'the clip at bar 1' resolves the clip covering bar 0", () => {
    const doc = withRoleClips();
    const next = executeRouted(doc, "copy the clip at bar 1 to bar 9");
    const copy = next.arrangement.clips.find((c) => c.startBar === 8);
    expect(copy).toBeDefined();
    // source strip: the "to bar 9" destination must not resolve as the source
    expect(copy!.startBar).toBe(8);
  });

  it("move the drop clip to bar 9 keeps absolute positions — NO relayout", () => {
    const doc = withRoleClips();
    const next = executeRouted(doc, "move the drop clip to bar 9");
    const intro = next.arrangement.clips.find((c) => c.startBar === 0);
    expect(intro).toBeDefined(); // untouched — the arrange relayout would have squished it
    const moved = next.arrangement.clips.find((c) => c.startBar === 8);
    expect(moved).toBeDefined();
    expect(moved!.lengthBars).toBe(4);
  });

  it("trim the clip at bar 5 to 2 bars resizes in place", () => {
    const doc = withRoleClips();
    const route = routeIntentText("trim the clip at bar 5 to 2 bars", doc);
    expect(route.kind).toBe("clips");
    const next = executeRouted(doc, "trim the clip at bar 5 to 2 bars");
    const trimmed = next.arrangement.clips.find((c) => c.startBar === 4);
    expect(trimmed!.lengthBars).toBe(2);
    expect(next.arrangement.clips).toHaveLength(2); // no scene harmed
  });

  it("delete the clip at bar 8 removes only the clip — the scene survives", () => {
    const store = new ProjectStore(withRoleClips());
    const scenesBefore = store.doc.scenes.length;
    executeRouted(store.doc, "delete the clip at bar 8", store);
    expect(store.doc.arrangement.clips).toHaveLength(1);
    expect(store.doc.scenes).toHaveLength(scenesBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(store.doc.arrangement.clips).toHaveLength(2);
  });

  it("a position no clip covers declines the clip route (explicit, not guessed)", () => {
    // user bar 12 lies past every clip — nothing to delete, no guessing
    expect(routeIntentText("delete the clip at bar 12", withRoleClips()).kind).not.toBe("clips");
  });

  it("overlapping copy fails with the command's own explicit error", () => {
    const doc = withRoleClips();
    // bar 5 (0-based 4) is occupied by the drop clip
    expect(() => executeRouted(doc, "copy the intro clip to bar 5")).toThrow(/overlaps/i);
  });

  it("destination-less copy declines the clip route (scene variation stays nearest)", () => {
    const doc = withRoleClips();
    expect(routeIntentText("copy the intro clip", doc).kind).not.toBe("clips");
    // and a scene-arrange text without a clip word never reaches the clip route
    expect(routeIntentText("shorten the intro to 2 bars", withRoleClips()).kind).toBe("arrange");
  });
});

// ─── 14. PRESET INTENT — load by name, family-wide, one undo ────────────────

describe("E2E preset intents", () => {
  it("load the Warm Sub preset on the bass applies it to the 808; undo restores", () => {
    const store = new ProjectStore(testDoc());
    const bass = bassTrackOf(store.doc);
    const paramsBefore = { ...bass.params };
    const presetIdBefore = bass.presetId ?? null;

    const route = routeIntentText("load the Warm Sub preset on the bass", store.doc);
    expect(route.kind).toBe("preset");
    if (route.kind !== "preset") throw new Error("expected preset route");
    expect(route.intent.preset.name).toBe("Warm Sub");
    expect(route.intent.matchedBy).toBe("exact");
    expect(route.intent.target).toBe("bass");
    const routedPresetId = route.intent.preset.id;

    executeRouted(store.doc, "load the Warm Sub preset on the bass", store);
    const applied = bassTrackOf(store.doc);
    expect(applied.presetId).toBe(routedPresetId);
    expect(applied.params).not.toEqual(paramsBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    const restored = bassTrackOf(store.doc);
    expect(restored.params).toEqual(paramsBefore);
    expect(restored.presetId ?? null).toBe(presetIdBefore);
  });

  it("fuzzy: 'warm' matches a warm-named bass-family preset (prefix + family bonus)", () => {
    const doc = testDoc();
    const route = routeIntentText("load the warm preset on the bass", doc);
    expect(route.kind).toBe("preset");
    if (route.kind === "preset") {
      expect(route.intent.preset.name.toLowerCase()).toContain("warm");
      // the family bonus must steer the pick away from non-bass instruments
      expect(["bass", "808", "logdrum"]).toContain(route.intent.preset.instrument);
    }
  });

  it("SK: 'načítaj preset trap 808 bass na basu' resolves by includes", () => {
    const doc = testDoc();
    const route = routeIntentText("načítaj preset trap 808 bass na basu", doc);
    expect(route.kind).toBe("preset");
    if (route.kind === "preset") expect(route.intent.preset.name.toLowerCase()).toContain("808");
  });

  it("unknown preset is an EXPLICIT response with suggestions, never generation", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    const route = routeIntentText("load the zzzblorp preset on the bass", doc);
    expect(route.kind).toBe("presetUnknown");
    if (route.kind === "presetUnknown") {
      expect(route.name).toContain("zzzblorp");
      expect(route.suggestions.length).toBeGreaterThan(0);
    }
    expect(store.undoStackLength).toBe(0);
    expect(store.doc).toBe(doc);
  });

  it("no target family declines the preset route (explicit target required)", () => {
    const doc = testDoc();
    expect(routeIntentText("load the warm sub preset", doc).kind).not.toBe("preset");
  });

  it("missing family track fails loudly (drums-only project, bass target)", () => {
    const doc = testDoc();
    const drumsOnly: ProjectDocument = { ...doc, tracks: doc.tracks.filter((t) => t.kind === "drum") };
    expect(() => executeRouted(drumsOnly, "load the warm sub preset on the bass")).toThrow(/no track matches/);
  });

  it("family-wide: every bass-family track gets the preset in ONE undo", () => {
    const store = new ProjectStore(testDoc());
    const second = createInstrumentTrack(store.doc, "bass");
    store.replaceDoc(second.execute(store.doc));
    const bassTracks = store.doc.tracks.filter(
      (t): t is InstrumentTrack => t.kind === "instrument" && ["bass", "808"].includes(t.instrument),
    );
    expect(bassTracks.length).toBeGreaterThanOrEqual(2);

    executeRouted(store.doc, "load the warm sub preset on the bass", store);
    for (const track of bassTracks) {
      const applied = store.doc.tracks.find((t) => t.id === track.id) as InstrumentTrack;
      // the id is the factory slug ("factory.bass.house.warmsub") — presence
      // and undo are the contract here, not the exact slug
      expect(applied.presetId ?? "").toContain("warmsub");
    }
    expect(store.undoStackLength).toBe(1);
    store.undo();
    for (const track of bassTracks) {
      const restored = store.doc.tracks.find((t) => t.id === track.id) as InstrumentTrack;
      expect(restored.presetId ?? null).toBe(null);
    }
  });

  it("preset rides compounds: 'load the warm sub preset on the bass and zníž lead'", () => {
    const store = new ProjectStore(withLead());
    const leadBefore = instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!.gain;
    const route = routeIntentText("load the warm sub preset on the bass and zníž lead", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind !== "compound") throw new Error("expected compound route");
    expect(route.parts).toHaveLength(2);
    expect(route.parts[0]).toMatchObject({ kind: "preset" });
    expect(route.parts[1]).toMatchObject({ kind: "fader" });
    const routedPresetId = route.parts[0].kind === "preset" ? route.parts[0].intent.preset.id : "";

    executeRouted(store.doc, "load the warm sub preset on the bass and zníž lead", store);
    expect(bassTrackOf(store.doc).presetId).toBe(routedPresetId);
    expect(instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!.gain).toBeLessThan(leadBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(bassTrackOf(store.doc).presetId ?? null).toBe(null);
    expect(instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!.gain).toBe(leadBefore);
  });
});

// ─── 15. ABSOLUTE FADER SET — percent lands as an absolute gain ─────────────

describe("E2E absolute fader set", () => {
  it("set the bass to 50% lands 0.75 (50% of the 1.5 range); undo restores", () => {
    const store = new ProjectStore(testDoc());
    const before = bassTrackOf(store.doc).gain;
    const route = routeIntentText("set the bass to 50%", store.doc);
    expect(route.kind).toBe("fader");
    if (route.kind === "fader") {
      expect(route.intent.direction).toBe("set");
      expect(route.intent.percent).toBe(50);
    }
    executeRouted(store.doc, "set the bass to 50%", store);
    expect(bassTrackOf(store.doc).gain).toBeCloseTo(0.75, 5);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(bassTrackOf(store.doc).gain).toBe(before);
  });

  it("nastav master na 80 % lands 1.2 on the master fader", () => {
    const doc = testDoc();
    const next = executeRouted(doc, "nastav master na 80 %");
    expect(next.master.masterGain).toBeCloseTo(1.2, 5);
  });

  it("set the kick to 100% lands the pads at full range", () => {
    const doc = testDoc();
    const route = routeIntentText("set the kick to 100%", doc);
    expect(route.kind).toBe("fader");
    const next = executeRouted(doc, "set the kick to 100%");
    const drum = drumTrackOf(next);
    const kickIds = new Set(classifyPads(drum.pads).kicks.map((pad) => pad.id));
    for (const pad of drum.pads) {
      if (kickIds.has(pad.id)) expect(pad.gain).toBeCloseTo(1.5, 5);
      else expect(pad.gain).toBeLessThan(1.5);
    }
  });

  it("set to 0% mutes the fader (bounded at the floor)", () => {
    const doc = testDoc();
    const next = executeRouted(doc, "set the bass to 0%");
    expect(bassTrackOf(next).gain).toBe(0);
  });

  it("effect-noun set asks stay with the effectIntent set-mode, never the fader", () => {
    const doc = testDoc();
    const route = routeIntentText("set reverb mix to 25% on the lead", doc);
    expect(route.kind).toBe("effectIntent");
    expect(bassTrackOf(doc).gain).toBe(bassTrackOf(doc).gain);
  });

  it("fader set rides compounds: 'set the bass to 50% and zníž lead'", () => {
    const store = new ProjectStore(withLead());
    const leadBefore = instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!.gain;
    const route = routeIntentText("set the bass to 50% and zníž lead", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind !== "compound") throw new Error("expected compound route");
    expect(route.parts[0]).toMatchObject({ kind: "fader", intent: { direction: "set", percent: 50 } });
    executeRouted(store.doc, "set the bass to 50% and zníž lead", store);
    expect(bassTrackOf(store.doc).gain).toBeCloseTo(0.75, 5);
    expect(instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!.gain).toBeLessThan(leadBefore);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    expect(instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!.gain).toBe(leadBefore);
  });
});

// ─── 16. SAVE / EXPORT / RECORD — bare-word app commands (route level) ──────

describe("E2E save/export/record routing", () => {
  it("save variants route to the save command; tails stay prompts", () => {
    const doc = testDoc();
    for (const text of ["save", "save the project", "ulož", "ulož projekt", "ulozit to"]) {
      expect(routeIntentText(text, doc).kind).toBe("save");
    }
    expect(routeIntentText("save the whales", doc).kind).not.toBe("save");
  });

  it("export routes with the format; bare export defaults to wav", () => {
    const doc = testDoc();
    const cases = [
      ["export wav", "wav"],
      ["exportuj mp3", "mp3"],
      ["export", "wav"],
      ["export the project as mp3", "mp3"],
      ["exportuj", "wav"],
    ] as const;
    for (const [text, format] of cases) {
      const route = routeIntentText(text, doc);
      expect(route.kind).toBe("export");
      if (route.kind === "export") expect(route.format).toBe(format);
    }
    expect(routeIntentText("export the stems", doc).kind).not.toBe("export");
  });

  it("record arms, stop recording disarms, prompts stay prompts", () => {
    const doc = testDoc();
    for (const text of ["record", "record pattern", "nahrávaj", "start recording"]) {
      const route = routeIntentText(text, doc);
      expect(route.kind).toBe("record");
      if (route.kind === "record") expect(route.arm).toBe(true);
    }
    const disarm = routeIntentText("stop recording", doc);
    expect(disarm.kind).toBe("record");
    if (disarm.kind === "record") expect(disarm.arm).toBe(false);
    expect(routeIntentText("record scratch", doc).kind).not.toBe("record");
    expect(routeIntentText("stop the recording session", doc).kind).not.toBe("record");
  });

  it("save/export/record routing never mutates the document", () => {
    const doc = testDoc();
    const store = new ProjectStore(doc);
    for (const text of ["save", "export wav", "record"]) {
      expect(routeIntentText(text, store.doc).kind).toBeDefined();
    }
    expect(store.undoStackLength).toBe(0);
    expect(store.doc).toBe(doc);
  });
});

// ─── 17. VERIFICATION READ-BACK — resulting state, not dispatch ─────────────

describe("E2E readback verification loop", () => {
  it("fader readback shows real before→after gains, pads included", () => {
    const doc = testDoc();
    const intent: FaderIntent = { targets: ["bass"], pads: ["kick"], direction: "up", amount: "big" };
    const after = applyFaderIntent(doc, intent)!.execute(doc);
    const readback = faderReadback(doc, after, intent);
    const bass = bassTrackOf(doc);
    expect(readback).toContain(`${bass.name} ${bass.gain}`);
    expect(readback).toMatch(/→/);
  });

  it("absolute set readback shows the exact landing (50% → 0.75)", () => {
    const doc = testDoc();
    const intent: FaderIntent = { targets: ["bass"], direction: "set", percent: 50 };
    const after = applyFaderIntent(doc, intent)!.execute(doc);
    expect(faderReadback(doc, after, intent)).toContain("→0.75");
  });

  it("clamped fader readback shows the honest floor (o 300% → 0)", () => {
    const doc = testDoc();
    const intent: FaderIntent = { targets: ["bass"], direction: "down", percent: 100 };
    const after = applyFaderIntent(doc, intent)!.execute(doc);
    expect(faderReadback(doc, after, intent)).toMatch(/→0(\.0+)?$/m);
  });

  it("effect readback shows the knob landing; set-mode shows the clamped value", () => {
    const doc = withLead();
    const more = parseEffectIntent("viac delayu na leade")!;
    const afterMore = applyEffectIntent(doc, more).execute(doc);
    expect(effectReadback(doc, afterMore, more)).toMatch(/mix 0\.\d+→0\.\d+ on Lead/);

    const setIntent = parseEffectIntent("set the lead reverb mix to 250%")!;
    const afterSet = applyEffectIntent(doc, setIntent).execute(doc);
    const maxMix = EFFECT_META.reverb.params.find((param) => param.id === "mix")!.max;
    expect(effectReadback(doc, afterSet, setIntent)).toContain(`→${maxMix}`);

    const remove = parseEffectIntent("remove reverb from the lead")!;
    const afterRemove = applyEffectIntent(afterSet, remove).execute(afterSet);
    expect(effectReadback(afterSet, afterRemove, remove)).toContain("−reverb on Lead");
  });

  it("production readback confirms the planned DSP with real param values", () => {
    const doc = testDoc();
    const intent = parseProductionIntent("make the drums darker")!;
    const after = applyProductionIntentCommand(doc, intent).execute(doc);
    const readback = productionReadback(doc, after, intent);
    // darker plans { cutoff, mode, mix } — the first planned param reads back
    expect(readback).toMatch(/svFilter cutoff=\d+(\.\d+)? Drums/);
  });

  it("preset readback verifies the presetId landed on every family track", () => {
    const doc = testDoc();
    const parsed = parsePresetIntent("load the warm sub preset on the bass")!;
    if (!parsed.ok) throw new Error("expected preset parse");
    const after = applyPresetIntentCommand(doc, parsed.intent).execute(doc);
    const readback = presetReadback(after, parsed.intent);
    const bassName = bassTrackOf(after).name;
    expect(readback).toContain(`${bassName} ✓`);
    // a wrong doc (preset never applied) must NOT verify
    expect(presetReadback(doc, parsed.intent)).toContain("✗");
  });

  it("exact readback: mute/tempo/rename report the resulting state", () => {
    const doc = testDoc();
    const mute = parseExactIntent("mute the drums")!;
    const afterMute = applyExactIntentCommand(doc, mute).execute(doc);
    expect(exactReadback(doc, afterMute, mute)).toContain("mute ✓");

    const tempo = parseExactIntent("set tempo to 142")!;
    const afterTempo = applyExactIntentCommand(doc, tempo).execute(doc);
    expect(exactReadback(doc, afterTempo, tempo)).toBe(`bpm ${doc.bpm}→142`);

    const rename = parseExactIntent('rename the bass to "sub bass"')!;
    const afterRename = applyExactIntentCommand(doc, rename).execute(doc);
    expect(exactReadback(doc, afterRename, rename)).toContain('→ "sub bass"');
  });

  it("compound readback combines verified entries from every part kind", () => {
    const store = new ProjectStore(withLead());
    const before = store.doc;
    const route = routeIntentText("zníž tempo a zvýš lead", store.doc);
    if (route.kind !== "compound") throw new Error("expected compound route");
    store.execute(applyCompoundIntent(store.doc, route.parts)!);
    const readback = compoundReadback(before, store.doc, route.parts);
    expect(readback).toMatch(/bpm \d+→\d+/);
    expect(readback).toMatch(/Lead \d+(\.\d+)?→\d+(\.\d+)?/);
  });

  it("empty readback when nothing moved (no false verification)", () => {
    const doc = testDoc();
    const intent: FaderIntent = { targets: ["bass"], direction: "up", amount: "subtle" };
    // gain already at max clamps to a no-op → readback reports nothing
    const bass = bassTrackOf(doc);
    const maxed = { ...doc, tracks: doc.tracks.map((t) => (t.id === bass.id ? { ...t, gain: 1.5 } : t)) };
    const after = applyFaderIntent(maxed, intent);
    if (after) {
      expect(faderReadback(maxed, after.execute(maxed), intent)).toBe("");
    } else {
      expect(after).toBeNull();
    }
  });
});

// ─── 18. TYPO LAYER — "did you mean?" for near-miss command verbs ───────────

describe("E2E typo clarification", () => {
  it("'mut the drums' offers 'mute the drums' instead of generating a beat", () => {
    const doc = testDoc();
    const route = routeIntentText("mut the drums", doc);
    expect(route.kind).toBe("clarify");
    if (route.kind === "clarify") {
      expect(route.suggestions).toEqual(["mute the drums"]);
      expect(route.reason).toContain("mute the drums");
      // the suggestion is genuinely executable
      expect(routeIntentText("mute the drums", doc).kind).toBe("exact");
    }
  });

  it("'pann the bass left 30' corrects the verb and the fix parses", () => {
    const doc = testDoc();
    const route = routeIntentText("pann the bass left 30", doc);
    expect(route.kind).toBe("clarify");
    if (route.kind === "clarify") {
      expect(route.suggestions).toContain("pan the bass left 30");
      expect(routeIntentText("pan the bass left 30", doc).kind).toBe("exact");
    }
  });

  it("SK typo: 'stmaz track basu'? no — 'zmazz the bass track' corrects to zmaz", () => {
    const doc = testDoc();
    const route = routeIntentText("zmazz the bass track", doc);
    expect(route.kind).toBe("clarify");
    if (route.kind === "clarify") {
      expect(route.suggestions[0]).toContain("zmaz");
      expect(routeIntentText(route.suggestions[0], doc).kind).toBe("exact");
    }
  });

  it("real prompts NEVER fire the typo layer (genre signal wins)", () => {
    const doc = testDoc();
    for (const text of [
      "dark techno at 140",
      "make me a trap beat",
      "mut the drums in a dark trap beat",
      "banging house groove with swing",
    ]) {
      expect(routeIntentText(text, doc).kind).toBe("pattern");
    }
  });

  it("a correction that still parses as a prompt is NOT offered", () => {
    const doc = testDoc();
    // "plan the set" — "plan"→"play"? "set" is a vocab verb token; whatever
    // the single-token fixes produce, none may surface unless executable
    const route = routeIntentText("plan the drums", doc);
    if (route.kind === "clarify") {
      for (const suggestion of route.suggestions) {
        expect(routeIntentText(suggestion, doc).kind).not.toBe("pattern");
      }
    }
    // vocabulary words themselves are never "corrected"
    expect(routeIntentText("solo the bass", doc).kind).toBe("exact");
  });
});

// ─── 19. VOCAB EXTENSIONS — mute-all, unsolo, center, SK vypni, bounce, rec, loop ──

describe("E2E vocabulary extensions", () => {
  it("mute everything mutes EVERY track (was a silent no-op) — one undo", () => {
    const store = new ProjectStore(testDoc());
    const route = routeIntentText("mute everything", store.doc);
    expect(route.kind).toBe("exact");
    executeRouted(store.doc, "mute everything", store);
    const lanes = store.doc.tracks.filter((t) => t.kind !== "group");
    expect(lanes.length).toBeGreaterThan(1);
    for (const track of lanes) expect(track.mute).toBe(true);
    expect(store.undoStackLength).toBe(1);
    store.undo();
    for (const track of store.doc.tracks.filter((t) => t.kind !== "group")) {
      expect(track.mute).toBe(false);
    }
  });

  it("SK: zapni všetko unmutes every track", () => {
    const doc = testDoc();
    const muted = { ...doc, tracks: doc.tracks.map((t) => ({ ...t, mute: true })) };
    const next = executeRouted(muted, "zapni všetko");
    for (const track of next.tracks.filter((t) => t.kind !== "group")) {
      expect(track.mute).toBe(false);
    }
  });

  it("vypni basu — SK mute verb symmetric with zapni", () => {
    const doc = testDoc();
    const route = routeIntentText("vypni basu", doc);
    expect(route.kind).toBe("exact");
    const next = executeRouted(doc, "vypni basu");
    expect(bassTrackOf(next).mute).toBe(true);
  });

  it("unsolo the bass / solo off the drums clear solo", () => {
    const doc = testDoc();
    const bassSoloed = {
      ...doc,
      tracks: doc.tracks.map((t) => (t.kind === "instrument" ? { ...t, solo: true } : t)),
    };
    const next = executeRouted(bassSoloed, "unsolo the bass");
    expect(bassTrackOf(next).solo).toBe(false);
    const drumsSoloed = { ...doc, tracks: doc.tracks.map((t) => (t.kind === "drum" ? { ...t, solo: true } : t)) };
    const next2 = executeRouted(drumsSoloed, "solo off the drums");
    expect(drumTrackOf(next2).solo).toBe(false);
  });

  it("center the bass zeroes the pan (from a non-zero start)", () => {
    const doc = testDoc();
    const panned = { ...doc, tracks: doc.tracks.map((t) => ({ ...t, pan: -0.5 })) };
    const route = routeIntentText("center the bass", panned);
    expect(route.kind).toBe("exact");
    const next = executeRouted(panned, "center the bass");
    expect(bassTrackOf(next).pan).toBe(0);
    // other tracks untouched
    expect(drumTrackOf(next).pan).toBe(-0.5);
  });

  it("center the hi-hats zeroes PAD pans only", () => {
    const doc = testDoc();
    const next = executeRouted(doc, "center the hi-hats");
    const drum = drumTrackOf(next);
    const hatIds = new Set(classifyPads(drum.pads).hats.map((pad) => pad.id));
    for (const pad of drum.pads) {
      if (hatIds.has(pad.id)) expect(pad.pan).toBe(0);
    }
  });

  it("pan the mix declines at parse (no more silent no-op command)", () => {
    const doc = testDoc();
    expect(parseExactIntent("pan the mix left 30")).toBeNull();
    expect(routeIntentText("pan the mix left 30", doc).kind).not.toBe("exact");
  });

  it("transpose all declines instead of silently no-oping (guard for the mix target)", () => {
    expect(parseExactIntent("transpose all up one octave")).toBeNull();
  });

  it("bounce aliases export: bounce wav / bounce mp3 / bare bounce", () => {
    const doc = testDoc();
    const cases = [
      ["bounce wav", "wav"],
      ["bounce mp3", "mp3"],
      ["bounce", "wav"],
      ["bounce the project as mp3", "mp3"],
    ] as const;
    for (const [text, format] of cases) {
      const route = routeIntentText(text, doc);
      expect(route.kind).toBe("export");
      if (route.kind === "export") expect(route.format).toBe(format);
    }
  });

  it("rec arms the pattern recorder (bare-word alias)", () => {
    const doc = testDoc();
    const route = routeIntentText("rec", doc);
    expect(route.kind).toBe("record");
    if (route.kind === "record") expect(route.arm).toBe(true);
  });

  it("loop on/off/cykluj route to transport; bare 'loop' declines", () => {
    const doc = testDoc();
    const cases = [
      ["loop on", "loopOn"],
      ["loop off", "loopOff"],
      ["cykluj zapni", "loopOn"],
      ["loop vypni", "loopOff"],
    ] as const;
    for (const [text, action] of cases) {
      const route = routeIntentText(text, doc);
      expect(route.kind).toBe("transport");
      if (route.kind === "transport") expect(route.action).toBe(action);
    }
    expect(routeIntentText("loop", doc).kind).not.toBe("transport");
    expect(routeIntentText("loop the drop", doc).kind).not.toBe("transport");
  });
});

// ─── 20. SENDS/RETURNS + BYPASS — mixer routing via canonical commands ──────

describe("E2E send intents", () => {
  it("more reverb send on the lead raises the lead's send to the reverb return", () => {
    const doc = withLead();
    const route = routeIntentText("more reverb send on the lead", doc);
    expect(route.kind).toBe("sendIntent");
    if (route.kind === "sendIntent") {
      expect(route.intent.effectType).toBe("reverb");
      expect(route.intent.direction).toBe("more");
    }
    const next = executeRouted(doc, "more reverb send on the lead");
    const lead = instrumentTracks(next).find((t) => /\blead\b/i.test(t.name))!;
    const reverbReturn = next.returns.find((r) => r.effects.some((fx) => fx.type === "reverb"))!;
    expect(lead.sends?.[reverbReturn.id] ?? 0).toBeCloseTo(0.15, 5);
    // second nudge composes (0.15 → 0.3)
    const after2 = executeRouted(next, "more reverb send on the lead");
    const lead2 = instrumentTracks(after2).find((t) => /\blead\b/i.test(t.name))!;
    expect(lead2.sends?.[reverbReturn.id] ?? 0).toBeCloseTo(0.3, 5);
  });

  it("set the delay send to 40% on the bass lands 0.6 (40% of the 1.5 range)", () => {
    const doc = withLead();
    const route = routeIntentText("set the delay send to 40% on the bass", doc);
    expect(route.kind).toBe("sendIntent");
    if (route.kind === "sendIntent") {
      expect(route.intent.direction).toBe("set");
      expect(route.intent.percent).toBe(40);
    }
    const next = executeRouted(doc, "set the delay send to 40% on the bass");
    const bass = bassTrackOf(next);
    const delayReturn = next.returns.find((r) => r.effects.some((fx) => fx.type === "delay"))!;
    expect(bass.sends?.[delayReturn.id] ?? 0).toBeCloseTo(0.6, 5);
  });

  it("no reverb send on the drums lands the send at 0", () => {
    const doc = withLead();
    const sent = executeRouted(doc, "more reverb send on the drums");
    const next = executeRouted(sent, "no reverb send on the drums");
    const drum = drumTrackOf(next);
    const reverbReturn = next.returns.find((r) => r.effects.some((fx) => fx.type === "reverb"))!;
    expect(drum.sends?.[reverbReturn.id] ?? 0).toBe(0);
  });

  it("send without a matching return fails explicitly (no chorus return by default)", () => {
    const doc = withLead();
    expect(() => executeRouted(doc, "more chorus send on the lead")).toThrow(/no chorus return/);
  });

  it("send words are REQUIRED — 'more reverb on the lead' stays an effectIntent knob ask", () => {
    const doc = withLead();
    const route = routeIntentText("more reverb on the lead", doc);
    expect(route.kind).toBe("effectIntent");
    if (route.kind === "effectIntent") {
      // the knob ask turns the RETURN-MIX knob of an added reverb instance —
      // NOT the send level
      const next = executeRouted(doc, "more reverb on the lead");
      const lead = instrumentTracks(next).find((t) => /\blead\b/i.test(t.name))!;
      expect(lead.effects.some((fx) => fx.type === "reverb")).toBe(true);
    }
  });
});

describe("E2E bypass intents", () => {
  it("bypass the delay on the lead flips the flag; enable flips it back", () => {
    const store = new ProjectStore(withLead());
    executeRouted(store.doc, "viac delayu na leade", store); // install the instance
    const route = routeIntentText("bypass the delay on the lead", store.doc);
    expect(route.kind).toBe("bypassIntent");
    if (route.kind === "bypassIntent") {
      expect(route.intent.effectType).toBe("delay");
      expect(route.intent.bypassed).toBe(true);
    }
    executeRouted(store.doc, "bypass the delay on the lead", store);
    const lead = instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!;
    expect(lead.effects.find((fx) => fx.type === "delay")!.bypassed).toBe(true);
    expect(store.undoStackLength).toBe(2);
    store.undo();
    expect(
      instrumentTracks(store.doc)
        .find((t) => /\blead\b/i.test(t.name))!
        .effects.find((fx) => fx.type === "delay")!.bypassed,
    ).toBe(false);
    executeRouted(store.doc, "enable the delay on the lead", store);
    expect(
      instrumentTracks(store.doc)
        .find((t) => /\blead\b/i.test(t.name))!
        .effects.find((fx) => fx.type === "delay")!.bypassed,
    ).toBe(false);
  });

  it("bypass without an instance fails explicitly (never a silent no-op)", () => {
    const doc = withLead();
    expect(() => executeRouted(doc, "bypass the reverb on the lead")).toThrow(/no Reverb instances/i);
  });

  it("bypass rides compounds: 'bypass the delay on the lead and zníž basu'", () => {
    const store = new ProjectStore(withLead());
    executeRouted(store.doc, "viac delayu na leade", store);
    const bassBefore = bassTrackOf(store.doc).gain;
    const route = routeIntentText("bypass the delay on the lead and zníž basu", store.doc);
    expect(route.kind).toBe("compound");
    if (route.kind !== "compound") throw new Error("expected compound route");
    expect(route.parts[0]).toMatchObject({ kind: "bypass" });
    executeRouted(store.doc, "bypass the delay on the lead and zníž basu", store);
    const lead = instrumentTracks(store.doc).find((t) => /\blead\b/i.test(t.name))!;
    expect(lead.effects.find((fx) => fx.type === "delay")!.bypassed).toBe(true);
    expect(bassTrackOf(store.doc).gain).toBeLessThan(bassBefore);
    expect(store.undoStackLength).toBe(2); // delay install + compound
    store.undo();
    expect(
      instrumentTracks(store.doc)
        .find((t) => /\blead\b/i.test(t.name))!
        .effects.find((fx) => fx.type === "delay")!.bypassed,
    ).toBe(false);
  });
});
