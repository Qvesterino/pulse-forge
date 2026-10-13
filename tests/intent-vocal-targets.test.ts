import { describe, expect, it } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { parseExactIntent } from "../src/intent/exact";
import { applyFaderIntent, faderReadback } from "../src/intent/conversation";
import { applyExactIntentCommand, resolveExactTargetTracks } from "../src/commands/intentRouting";
import { resolveProductionTargets } from "../src/intent/production";
import { createInstrumentTrack, setTrackParams, addAudioClip } from "../src/commands/commands";
import { ProjectStore } from "../src/store/ProjectStore";
import { testDoc } from "./fixtures/doc";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * P1-A DOCUMENT-DERIVED TARGET RESOLUTION (control-surface audit 2026-10-13,
 * GAP-03 / roadmap P1-A). The deterministic language layer was a closed
 * vocabulary while the document is open — "lower the vocal by 2 dB", the
 * most common mixing ask in any DAW, clarified with "which fader?" because
 * the fader tables had no vocal. This suite pins the root fix:
 *
 *  V1 "vocal" is a first-class fader target — the audited probe routes to
 *     the fader and EXECUTES (named vocal track wins)
 *  V2 unnamed vocals resolve from the singer's takes (audio-clip bindings) —
 *     mix.ts MixTarget parity, never a positional guess
 *  V3 the user's OWN track names are addressable without a code change
 *     ("turn down the fx return bus") — resolved at route time, before the
 *     loudness parser can claim a "lower … by 2 db" ask
 *  V4 the volume noun/adjective is not the voice ("zníž hlasitosť basu"
 *     stays a bass ask; "hlasnejšie bicie" stays drums)
 *  V5 exact ops resolve vocal strictly (mute/solo/pan by name or kind);
 *     destructive resolution has NO clip-binding fallback; the melodic
 *     transpose declines vocal instead of silently no-oping
 *  V6 generation asks about vocals still generate ("add vocals" is a brief)
 */

function trackNamed(doc: ProjectDocument, name: string): string {
  const match = doc.tracks.find((t) => t.name === name);
  if (!match) throw new Error(`fixture track "${name}" missing`);
  return match.id;
}

function docWith(tracks: Array<{ name: string; clip?: boolean }>): ProjectDocument {
  let doc = testDoc();
  for (const spec of tracks) {
    doc = createInstrumentTrack(doc, "analog").execute(doc);
    const id = doc.tracks.at(-1)!.id;
    doc = setTrackParams(doc, id, { name: spec.name }).execute(doc);
    if (spec.clip) doc = addAudioClip(doc, id, `buf-${spec.name}`, 0, 4).execute(doc);
  }
  return doc;
}

describe("P1-A vocal fader target (GAP-03)", () => {
  it("V1 the audited probe routes to the fader and names the vocal target", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("lower the vocal by 2 dB", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(route.intent.targets).toContain("vocal");
  });

  it("V1 execution moves the named vocal track's fader — one undo step", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("lower the vocal by 2 dB", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    const store = new ProjectStore(doc);
    const before = store.getDoc().tracks.find((t) => t.name === "Vox")!.gain;
    const command = applyFaderIntent(doc, route.intent);
    expect(command).not.toBeNull();
    if (!command) return;
    store.execute(command);
    const after = store.getDoc().tracks.find((t) => t.name === "Vox")!.gain;
    // A stated magnitude must apply that magnitude (SILENT-DEFAULT rule):
    // −2 dB converts to the fold's relative percent (20.6 %), never the
    // vibe step. Faders store 2-decimal values — the pin is the percent
    // conversion plus gain to the fader's own resolution.
    expect(route.intent.percent).toBe(20.6);
    // Double rounding is inherent (percent to 1 decimal, fader to 2): the
    // honest gain tolerance is one rounded fader step, not float parity.
    expect(after).toBeCloseTo(before * Math.pow(10, -2 / 20), 1);
    // every other fader untouched
    for (const track of store.getDoc().tracks) {
      if (track.name === "Vox") continue;
      expect(track.gain).toBe(doc.tracks.find((t) => t.id === track.id)!.gain);
    }
    store.undo();
    expect(store.getDoc().tracks.find((t) => t.name === "Vox")!.gain).toBe(before);
  });

  it("V2 unnamed vocals resolve from audio-clip bindings (mix.ts parity)", () => {
    const doc = docWith([{ name: "Take A", clip: true }]);
    const route = routeIntentText("lower the vocal by 2 dB", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    const command = applyFaderIntent(doc, route.intent);
    expect(command).not.toBeNull();
    if (!command) return;
    const next = command.execute(doc);
    const takeA = next.tracks.find((t) => t.name === "Take A")!.gain;
    expect(takeA).toBeLessThan(doc.tracks.find((t) => t.name === "Take A")!.gain);
    const readback = faderReadback(doc, next, route.intent);
    expect(readback).toContain("Take A");
  });

  it("V2 a NAMED vocal track wins over clip-bound tracks", () => {
    const doc = docWith([{ name: "Take A", clip: true }, { name: "Lead Vocal" }]);
    const route = routeIntentText("lower the vocal by 2 dB", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    const command = applyFaderIntent(doc, route.intent);
    expect(command).not.toBeNull();
    if (!command) return;
    const next = command.execute(doc);
    expect(next.tracks.find((t) => t.name === "Lead Vocal")!.gain).toBeLessThan(
      doc.tracks.find((t) => t.name === "Lead Vocal")!.gain,
    );
    expect(next.tracks.find((t) => t.name === "Take A")!.gain).toBe(doc.tracks.find((t) => t.name === "Take A")!.gain);
  });

  it("V1 SK: 'zníž vokál o 3 db' applies exactly −3 dB", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("zníž vokál o 3 db", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(route.intent.targets).toContain("vocal");
    // −3 dB → ×10^(−3/20) → 29.2 % relative (faders store 2 decimals).
    expect(route.intent.percent).toBe(29.2);
    const command = applyFaderIntent(doc, route.intent);
    expect(command).not.toBeNull();
    if (!command) return;
    const next = command.execute(doc);
    const before = doc.tracks.find((t) => t.name === "Vox")!.gain;
    expect(next.tracks.find((t) => t.name === "Vox")!.gain).toBeCloseTo(before * Math.pow(10, -3 / 20), 1);
  });

  it("V2 no vocal anywhere → the fader command is honestly null, never a guessed track", () => {
    const doc = docWith([{ name: "Reed 200" }]);
    const route = routeIntentText("lower the vocal by 2 dB", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(applyFaderIntent(doc, route.intent)).toBeNull();
  });

  it("V6 'add vocals' still generates — vocal words stay a creative-brief signal", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("add vocals", doc);
    expect(route.kind).not.toBe("fader");
    expect(route.kind).not.toBe("exact");
  });
});

describe("P1-A document-derived track names (FX Return Bus acceptance)", () => {
  it("V3 the user's own track name is addressable without a code change", () => {
    const doc = docWith([{ name: "FX Return Bus" }]);
    const route = routeIntentText("turn down the fx return bus", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(route.intent.trackIds).toEqual([trackNamed(doc, "FX Return Bus")]);
    const command = applyFaderIntent(doc, route.intent);
    expect(command).not.toBeNull();
    if (!command) return;
    const next = command.execute(doc);
    expect(next.tracks.find((t) => t.name === "FX Return Bus")!.gain).toBeLessThan(
      doc.tracks.find((t) => t.name === "FX Return Bus")!.gain,
    );
  });

  it("V3 'lower … by 2 db' on a named track is a fader ask, not a loudness nudge", () => {
    const doc = docWith([{ name: "FX Return Bus" }]);
    const route = routeIntentText("lower the fx return bus by 2 db", doc);
    expect(route.kind).toBe("fader");
  });

  it("V3 diacritics and case do not block the name match", () => {
    const doc = docWith([{ name: "Žiadny Reed 200" }]);
    const route = routeIntentText("stíš žiadny reed 200", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(route.intent.trackIds).toEqual([trackNamed(doc, "Žiadny Reed 200")]);
  });

  it("V3 no direction stem → not a fader ask (mentioning a track alone stays a prompt)", () => {
    const doc = docWith([{ name: "FX Return Bus" }]);
    expect(routeIntentText("the fx return bus is nice", doc).kind).not.toBe("fader");
  });
});

describe("P1-A volume-noun guard (the voice is not the loudness)", () => {
  it("V4 'zníž hlasitosť basu' stays a BASS ask", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("zníž hlasitosť basu", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(route.intent.targets).toEqual(["bass"]);
    expect(route.intent.targets).not.toContain("vocal");
  });

  it("V4 'hlasnejšie bicie' stays drums", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("hlasnejšie bicie", doc);
    expect(route.kind).toBe("fader");
    if (route.kind !== "fader") return;
    expect(route.intent.targets).toEqual(["drums"]);
  });
});

describe("P1-A exact-path vocal (strict resolution)", () => {
  it("V5 'mute the vocal' mutes the vocal-named track", () => {
    const doc = docWith([{ name: "Vox" }]);
    const plan = parseExactIntent("mute the vocal");
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.ops).toContainEqual({ kind: "mute", target: "vocal", value: true });
    expect(resolveExactTargetTracks(doc, "vocal")).toEqual([trackNamed(doc, "Vox")]);
    const command = applyExactIntentCommand(doc, plan);
    const next = command.execute(doc);
    expect(next.tracks.find((t) => t.name === "Vox")!.mute).toBe(true);
  });

  it("V5 destructive resolution has NO clip-binding fallback", () => {
    const doc = docWith([{ name: "Take A", clip: true }]);
    expect(resolveExactTargetTracks(doc, "vocal")).toEqual([]);
  });

  it("V5 the melodic transpose declines vocal instead of silently no-oping", () => {
    const doc = docWith([{ name: "Vox" }]);
    // The exact plan declines the op (null plan — nothing else in the phrase
    // is exact), and the ROUTE never claims an exact transpose for it.
    const plan = parseExactIntent("transpose the vocal up 2 semitones");
    expect(plan === null || plan.ops.some((op) => op.kind === "transpose")).toBe(true);
    const route = routeIntentText("transpose the vocal up 2 semitones", doc);
    expect(route.kind).not.toBe("exact");
  });

  it("V5 'select the vocal' resolves through the production resolver", () => {
    const doc = docWith([{ name: "Vox" }]);
    const route = routeIntentText("select the vocal", doc);
    expect(route.kind).toBe("select");
    if (route.kind !== "select") return;
    expect(resolveProductionTargets(doc, [route.target as never])).toEqual([trackNamed(doc, "Vox")]);
  });
});
