import { describe, it, expect } from "vitest";
import {
  parseFaderIntent,
  parseTempoIntent,
  parsePopIntent,
  applyFaderIntent,
  applyTempoIntent,
} from "../src/intent/conversation";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";

describe("parseFaderIntent", () => {
  it("SK: zníž basu → down + bass target", () => {
    const intent = parseFaderIntent("zníž basu");
    expect(intent).toEqual({ targets: ["bass"], direction: "down" });
  });

  it("SK: hlasnejšie bicie → up + drums", () => {
    expect(parseFaderIntent("hlasnejšie bicie")).toEqual({ targets: ["drums"], direction: "up" });
  });

  it("EN: turn down the drums", () => {
    expect(parseFaderIntent("turn down the drums")).toEqual({ targets: ["drums"], direction: "down" });
  });

  it("master: stíš celý mix", () => {
    expect(parseFaderIntent("stíš celý mix")).toEqual({ targets: ["master"], direction: "down" });
  });

  it("no direction / no target → null", () => {
    expect(parseFaderIntent("zníž")).toBeNull(); // direction without target
    expect(parseFaderIntent("basu")).toBeNull(); // target without direction
    expect(parseFaderIntent("dark techno")).toBeNull();
  });
});

describe("parseTempoIntent", () => {
  it("down: zníž tempo / pomalší", () => {
    expect(parseTempoIntent("zníž tempo")).toEqual({ direction: "down" });
    expect(parseTempoIntent("pomalší beat")).toEqual({ direction: "down" });
  });

  it("up: zrýchli to / faster", () => {
    expect(parseTempoIntent("zrýchli to")).toEqual({ direction: "up" });
    expect(parseTempoIntent("faster please")).toEqual({ direction: "up" });
  });

  it("set: tempo na 128 / 140 bpm", () => {
    expect(parseTempoIntent("tempo na 128")).toEqual({ direction: "set", bpm: 128 });
    expect(parseTempoIntent("140 bpm")).toEqual({ direction: "set", bpm: 140 });
  });

  it("no tempo word → null", () => {
    expect(parseTempoIntent("dark rainy techno")).toBeNull();
    expect(parseTempoIntent("zníž basu")).toBeNull(); // fader, not tempo
  });
});

describe("parsePopIntent", () => {
  it("popovejšie → brighter+punchier+wider composite on all tracks", () => {
    const intent = parsePopIntent("sprav to popovejšie");
    expect(intent).not.toBeNull();
    expect(intent?.targets).toEqual(["drums", "bass", "chords", "lead"]);
    expect(intent?.goals.map((goal) => goal.concept)).toEqual(["brighter", "punchier", "wider"]);
  });

  it("no pop phrase → null", () => {
    expect(parsePopIntent("dark techno")).toBeNull();
  });
});

describe("applyFaderIntent / applyTempoIntent", () => {
  it("down reduces the resolved bass track gain, one undoable command", () => {
    const doc = testDoc();
    // the fixture names may not say "bass" — the resolver falls back to the
    // first instrument track (ROLE_INDEX bass = 0)
    const bassTrack = doc.tracks.find((track) => track.kind === "instrument");
    expect(bassTrack).toBeDefined();
    const before = (bassTrack as { gain: number }).gain;
    const commands = applyFaderIntent(doc, { targets: ["bass"], direction: "down" });
    expect(commands).toHaveLength(1);
    const next = commands[0].execute(doc);
    const applied = next.tracks.find((track) => track.id === bassTrack!.id) as { gain: number };
    expect(applied.gain).toBeLessThan(before);
  });

  it("clamps at the fader floor (no negative gain)", () => {
    const doc = testDoc();
    const commands = applyFaderIntent(doc, { targets: ["master"], direction: "down" });
    const next = commands[0].execute(doc);
    expect(next.master?.masterGain).toBeGreaterThanOrEqual(0);
  });

  it("tempo down/up moves the project bpm by the step", () => {
    const doc = testDoc();
    const down = applyTempoIntent(doc, { direction: "down" }).execute(doc);
    expect(down.bpm).toBe(doc.bpm - 6);
    const up = applyTempoIntent({ ...doc, bpm: doc.bpm }, { direction: "up" }).execute(doc);
    expect(up.bpm).toBe(doc.bpm + 6);
  });

  it("tempo set: exact bpm", () => {
    const doc = testDoc();
    const next = applyTempoIntent(doc, { direction: "set", bpm: 128 }).execute(doc);
    expect(next.bpm).toBe(128);
  });
});

describe("router wiring", () => {
  it("routes conversation intents before generation", () => {
    const doc = testDoc();
    expect(routeIntentText("zníž basu", doc).kind).toBe("fader");
    expect(routeIntentText("zníž tempo", doc).kind).toBe("tempo");
    expect(routeIntentText("popovejšie", doc).kind).toBe("production");
    // pattern requests still win their own route
    expect(routeIntentText("dark techno at 138", doc).kind).toBe("pattern");
  });
});
