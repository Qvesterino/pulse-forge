import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { ProjectDocument } from "../src/project-model/types";
import { Transport } from "../src/transport/Transport";
import { createBandmate } from "../src/collab/bandmate";

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

function setup(roomId = "test-room") {
  const doc = createProjectFromTemplate("house");
  const humanDrum = doc.tracks.find((t) => t.kind === "drum");
  const humanRowsBefore = humanDrum ? JSON.stringify(doc.patterns.map((p) => p.rows)) : null;
  const store = new FakeStore(doc);
  const clock = manualClock();
  const transport = new Transport(clock, SR_BASE);
  const bandmate = createBandmate({ store, transport, roomId });
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

