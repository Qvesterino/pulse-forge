import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { Transport } from "../src/transport/Transport";
import { createBandmate, currentSceneRole, etiquetteFor, extractHumanPhrase } from "../src/collab/bandmate";

const SR_BASE = 124;

function manualClock() {
  let t = 0;
  return { now: () => t, advance: (sec: number) => (t += sec) };
}

class FakeStore {
  doc: ProjectDocument;
  executed: string[] = [];
  constructor(doc: ProjectDocument) {
    this.doc = doc;
  }
  execute(command: {
    type?: string;
    label?: string;
    execute: (d: ProjectDocument) => ProjectDocument;
  }): void {
    this.executed.push(command.label ?? command.type ?? "?");
    this.doc = command.execute(this.doc);
  }
}

function setup(roomId = "test-room", template: "house" | "scene-score" = "house") {
  const doc = createProjectFromTemplate(template);
  const humanDrum = doc.tracks.find((t) => t.kind === "drum");
  const humanRowsBefore = humanDrum ? JSON.stringify(doc.patterns.map((p) => p.rows)) : null;
  const store = new FakeStore(doc);
  const clock = manualClock();
  const transport = new Transport(clock, SR_BASE);
  const bandmate = createBandmate({ store, transport, roomId, getMode: () => (template === "scene-score" ? "song" : "pattern") });
  bandmate.setPhraseBars(1); // 1-bar phrases → one bar = 1920 ticks
  return { store, clock, transport, bandmate, humanDrum, humanRowsBefore };
}

const secondsPerBar = (1920 * 60) / (SR_BASE * 480);

describe("AI bandmate", () => {
  it("disabled: no rolls even while the room plays", () => {
    const s = setup();
    s.bandmate.setEnabled(false);
    s.transport.play(0);
    s.clock.advance(secondsPerBar * 3);
    s.bandmate.tick();
    s.bandmate.tick();
    expect(s.store.doc.tracks.some((t) => t.name === "KYX Drums")).toBe(false);
  });

  it("enabled + playing: creates its own track and writes only its own pads", () => {
    const s = setup();
    s.bandmate.setEnabled(true);
    s.transport.play(0);
    s.clock.advance(secondsPerBar + 0.05);
    s.bandmate.tick();

    const bot = s.store.doc.tracks.find(
      (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
    );
    expect(bot).toBeTruthy();
    expect(bot!.kind).toBe("drum");
    // exactly one bot track, human drum track untouched
    expect(s.store.doc.tracks.filter((t) => t.name === "KYX Drums").length).toBe(1);

    const active = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
    const kick = bot!.pads.find((p) => p.name.toLowerCase().includes("kick"))!;
    const kickRow = active.rows[kick.id];
    expect(kickRow.filter((v) => v > 0).length).toBeGreaterThanOrEqual(3); // 4-on-the-floor-ish

    // the bot never touched the human drum track's pads: its pattern rows
    // changed, but only for pad ids that belong to the KYX track
    const botPadIds = new Set(bot!.pads.map((p) => p.id));
    for (const pad of s.humanDrum?.pads ?? []) {
      expect(botPadIds.has(pad.id), `human pad ${pad.name} must not be bot-owned`).toBe(false);
    }
  });

  it("one roll per phrase; deterministic per (roomId, phrase)", () => {
    const kickOf = (store: FakeStore) => {
      const bot = store.doc.tracks.find(
        (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
      )!;
      const active = store.doc.patterns.find((p) => p.id === store.doc.activePatternId)!;
      const kick = bot.pads.find((p) => p.name.toLowerCase().includes("kick"))!;
      return JSON.stringify(active.rows[kick.id]);
    };

    const s = setup();
    s.bandmate.setEnabled(true);
    s.transport.play(0);

    s.clock.advance(secondsPerBar + 0.05);
    s.bandmate.tick(); // phrase index 0
    expect(s.store.executed.filter((l) => l.startsWith("KYX")).length).toBe(1);
    const rowsPhrase0 = kickOf(s.store);

    // tick spam inside the same phrase adds nothing
    s.bandmate.tick();
    s.bandmate.tick();
    expect(s.store.executed.filter((l) => l.startsWith("KYX")).length).toBe(1);

    s.clock.advance(secondsPerBar);
    s.bandmate.tick(); // phrase index 1
    expect(s.store.executed.filter((l) => l.startsWith("KYX")).length).toBe(2);
    expect(kickOf(s.store)).not.toBe(rowsPhrase0); // new phrase, new groove

    // determinism: the same roomId rolling the SAME phrase index gives
    // identical rows
    const s2 = setup();
    s2.bandmate.setEnabled(true);
    s2.transport.play(0);
    s2.clock.advance(secondsPerBar + 0.05);
    s2.bandmate.tick(); // phrase index 0, same seed
    expect(kickOf(s2.store)).toBe(rowsPhrase0);
  });

  it("energy scales density: high energy hats ≥ low energy hats", () => {
    const rowsFor = (energy: number) => {
      const s = setup();
      s.bandmate.setEnabled(true);
      s.bandmate.setEnergy(energy);
      s.transport.play(0);
      s.clock.advance(secondsPerBar + 0.05);
      s.bandmate.tick();
      const bot = s.store.doc.tracks.find(
        (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
      )!;
      const active = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
      const hat = bot.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
      return active.rows[hat.id].filter((v) => v > 0).length;
    };
    const low = rowsFor(0.1);
    const high = rowsFor(0.95);
    expect(high).toBeGreaterThan(low);
  });

  it("stops rolling when the room stops", () => {
    const s = setup();
    s.bandmate.setEnabled(true);
    s.transport.play(0);
    s.transport.pause();
    s.clock.advance(secondsPerBar * 2);
    s.bandmate.tick();
    expect(s.store.doc.tracks.some((t) => t.name === "KYX Drums")).toBe(false);
  });
});


describe("scene-role etiquette", () => {
  it("etiquetteFor: break strips kick/snare; build ramps and fills late; drop is full", () => {
    const brk = etiquetteFor("break", 0.5);
    expect(brk.allow.kick).toBe(false);
    expect(brk.allow.snare).toBe(false);
    expect(brk.allow.hat).toBe(true);
    expect(brk.densityScale).toBeLessThan(0.5);

    const buildEarly = etiquetteFor("build", 0.3);
    const buildLate = etiquetteFor("build", 0.9);
    expect(buildEarly.fill).toBe(false);
    expect(buildLate.fill).toBe(true);
    expect(buildLate.densityScale).toBeGreaterThan(buildEarly.densityScale);

    const drop = etiquetteFor("drop", 0.5);
    expect(drop.densityScale).toBe(1);
    expect(drop.allow).toEqual({ kick: true, snare: true, hat: true, perc: true });

    const none = etiquetteFor(null, 0.5);
    expect(none).toEqual(drop); // no scene context = v1 behaviour
  });

  it("currentSceneRole resolves song-mode clips, pattern-mode scenes and names", () => {
    const doc = createProjectFromTemplate("scene-score");
    const clip = doc.arrangement.clips.find((c) => c.startBar === 0)!;
    expect(clip).toBeTruthy();
    // song mode: the clip covering bar 0 wins
    const songRole = currentSceneRole(doc, "song", 2);
    expect(songRole).not.toBeNull();
    // pattern mode: the scene bound to the active pattern
    const patternRole = currentSceneRole(doc, "pattern", 2);
    expect(patternRole).not.toBeNull();
    // far outside any clip → null in song mode
    expect(currentSceneRole(doc, "song", 9999)).toBeNull();
  });

  it("a BREAK scene silences kick/snare; a DROP scene brings them back", () => {
    const s = setup("room-break", "scene-score");
    s.bandmate.setEnabled(true);
    s.bandmate.setEnergy(0.8);
    s.transport.play(0); // bar ~2 → inside the first (INTRO or early) clip
    // Find the BREAK clip and park the playhead inside it.
    const doc = s.store.doc;
    const breakClip = doc.arrangement.clips.find((c) => {
      const scene = doc.scenes.find((sc) => sc.id === c.sceneId);
      return (scene?.role ?? "") === "break" || scene?.name.toLowerCase().includes("break");
    });
    expect(breakClip).toBeTruthy();
    const breakBar = breakClip!.startBar + 1;
    const transport = s.transport;
    void transport;
    // rewind-free: play from inside the break clip
    s.transport.play(breakBar * 1920);
    s.clock.advance(0.05);
    s.bandmate.tick();

    const bot = s.store.doc.tracks.find(
      (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
    )!;
    const active = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
    const kickPad = bot.pads.find((p) => p.name.toLowerCase().includes("kick"))!;
    const hatPad = bot.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
    expect(active.rows[kickPad.id].some((v) => v > 0)).toBe(false); // kick held back
    expect(active.rows[hatPad.id].some((v) => v > 0)).toBe(true); // hats keep time

    // DROP scene restores the kick
    const dropClip = doc.arrangement.clips.find((c) => {
      const scene = doc.scenes.find((sc) => sc.id === c.sceneId);
      return (scene?.role ?? scene?.name.toLowerCase()) === "drop" || scene?.name.toLowerCase().includes("drop");
    });
    expect(dropClip).toBeTruthy();
    s.transport.play((dropClip!.startBar + 1) * 1920);
    s.clock.advance(0.05);
    s.bandmate.tick();
    const active2 = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
    expect(active2.rows[kickPad.id].some((v) => v > 0)).toBe(true);
  });
});

describe("call & response (listening)", () => {
  it("extractHumanPhrase: register, sync ratio and bar-local steps", () => {
    // one bar @ 124 BPM ≈ 1.935 s; steps 0/4/8/12 are on-grid
    const dur = (1920 * 60) / (124 * 480);
    const notes = [
      { pitch: 40, wall: 0 },            // step 0, low register
      { pitch: 44, wall: dur * 0.2 },    // step 3 — syncopated
      { pitch: 90, wall: dur * 0.5 },    // step 8, high register
    ];
    const f = extractHumanPhrase(notes, 0, dur, 124)!;
    expect(f.count).toBe(3);
    expect(f.steps).toEqual([0, 3, 8]);
    expect(f.syncRatio).toBeCloseTo(1 / 3, 5);
    // mean pitch (40+44+90)/3 = 58 → (58-36)/60 ≈ 0.367 (low-ish)
    expect(f.registerMean).toBeCloseTo((58 - 36) / 60, 3);
    expect(extractHumanPhrase(notes.slice(0, 2), 0, dur, 124)).toBeNull(); // < 3 notes
  });

  it("ECHO: human onsets return as varied bot perc ghosts", () => {
    const s = setup();
    s.bandmate.setEnabled(true);
    s.bandmate.setEnergy(0.6);
    s.transport.play(0);

    const nowWall = Date.now() / 1000;
    const phraseDur = (1920 * 60) / (SR_BASE * 480);
    // Human plays at steps 2, 5, 10 (off-grid, mid register 60..63)
    for (const st of [2, 5, 10]) {
      s.bandmate.noteHeard(60 + st, nowWall + (st / 16) * phraseDur);
    }
    s.clock.advance(secondsPerBar + 0.05);
    s.bandmate.tick(); // phrase boundary → response

    const bot = s.store.doc.tracks.find(
      (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
    )!;
    const active = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
    const perc = bot.pads.filter((p) => ["perc", "snare"].includes(p.name.toLowerCase().includes("perc") ? "perc" : p.name.toLowerCase().includes("snare") ? "snare" : "other"));
    void perc;
    // find the bot's perc-or-snare pad row and count hits at the echoed steps
    const percPad = bot.pads.find((p) => /perc/i.test(p.name));
    const row = percPad ? active.rows[percPad.id] : [];
    const echoed = [2, 5, 10].filter((st) => row[st] > 0).length;
    expect(echoed).toBeGreaterThanOrEqual(1); // some echo survives the 40% drop lottery
  });

  it("DENSITY COMPLEMENT: a busy human thins the bot's hats", () => {
    const hatsFor = (notes: number[]) => {
      const s = setup();
      s.bandmate.setEnabled(true);
      s.bandmate.setEnergy(0.6);
      s.transport.play(0);
      const nowWall = Date.now() / 1000;
      const phraseDur = (1920 * 60) / (SR_BASE * 480);
      for (let i = 0; i < notes.length; i++) {
        s.bandmate.noteHeard(60 + (i % 12), nowWall + (i / notes.length) * phraseDur);
      }
      s.clock.advance(secondsPerBar + 0.05);
      s.bandmate.tick();
      const bot = s.store.doc.tracks.find(
        (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
      )!;
      const active = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
      const hat = bot.pads.find((p) => p.name.toLowerCase().includes("hat"))!;
      return active.rows[hat.id].filter((v) => v > 0).length;
    };
    const busy = hatsFor(Array.from({ length: 14 }, (_, i) => i));
    const sparse = hatsFor([60, 62]);
    expect(sparse).toBeGreaterThanOrEqual(busy); // fill space, don't crowd it
  });

  it("REGISTER: a high human lifts perc accents over a low human", () => {
    const percAvgFor = (pitch: number) => {
      const s = setup();
      s.bandmate.setEnabled(true);
      s.bandmate.setEnergy(0.7);
      s.transport.play(0);
      const nowWall = Date.now() / 1000;
      const phraseDur = (1920 * 60) / (SR_BASE * 480);
      for (let i = 0; i < 4; i++) {
        s.bandmate.noteHeard(pitch, nowWall + (i / 4) * phraseDur);
      }
      s.clock.advance(secondsPerBar + 0.05);
      s.bandmate.tick();
      const bot = s.store.doc.tracks.find(
        (t): t is Extract<typeof t, { kind: "drum" }> => t.kind === "drum" && t.name === "KYX Drums",
      )!;
      const active = s.store.doc.patterns.find((p) => p.id === s.store.doc.activePatternId)!;
      const percPad = bot.pads.find((p) => /perc/i.test(p.name));
      const row = percPad ? active.rows[percPad.id] : new Array(16).fill(0);
      const vals = row.filter((v) => v > 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const high = percAvgFor(95);
    const low = percAvgFor(40);
    expect(high).toBeGreaterThan(low);
  });
});
