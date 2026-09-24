import { describe, it, expect } from "vitest";
import {
  parseFaderIntent,
  parseTempoIntent,
  parsePopIntent,
  applyFaderIntent,
  applyTempoIntent,
} from "../src/intent/conversation";
import { inferPadRole } from "../src/ai/pad-roles";
import type { DrumTrack } from "../src/project-model/types";
import { routeIntentText } from "../src/intent/route";
import { testDoc } from "./fixtures/doc";

describe("parseFaderIntent", () => {
  it("SK: zníž basu → down + bass target", () => {
    const intent = parseFaderIntent("zníž basu");
    expect(intent).toEqual({ targets: ["bass"], pads: [], direction: "down", amount: "normal" });
  });

  it("SK: hlasnejšie bicie → up + drums", () => {
    expect(parseFaderIntent("hlasnejšie bicie")).toEqual({
      targets: ["drums"],
      pads: [],
      direction: "up",
      amount: "normal",
    });
  });

  it("EN: turn down the drums", () => {
    expect(parseFaderIntent("turn down the drums")).toEqual({
      targets: ["drums"],
      pads: [],
      direction: "down",
      amount: "normal",
    });
  });

  it("master: stíš celý mix", () => {
    expect(parseFaderIntent("stíš celý mix")).toEqual({
      targets: ["master"],
      pads: [],
      direction: "down",
      amount: "normal",
    });
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

  it("named tracks beat the global loudness loop", () => {
    const doc = testDoc();
    // "hlasitosť 808s" names a track → fader, not the master nudge
    const routed = routeIntentText("zvýš hlasitosť 808s o 10%", doc);
    expect(routed.kind).toBe("fader");
    if (routed.kind === "fader") {
      expect(routed.intent.targets).toContain("bass");
      expect(routed.intent.direction).toBe("up");
      expect(routed.intent.percent).toBe(10);
    }
    // untargeted shouts still belong to loudness
    expect(routeIntentText("make it louder", doc).kind).toBe("loudness");
    expect(routeIntentText("hlasitosť hore", doc).kind).toBe("loudness");
  });
});

describe("fader percent + 808 targets", () => {
  it("parses o 10 % with 808s target", () => {
    expect(parseFaderIntent("zvýš hlasitosť 808s o 10%")).toEqual({
      targets: ["bass"],
      pads: [],
      direction: "up",
      amount: "normal",
      percent: 10,
    });
  });

  it("word fractions and EN forms", () => {
    expect(parseFaderIntent("stíš basu o polovicu")?.percent).toBe(50);
    expect(parseFaderIntent("turn down the drums by 25 percent")?.percent).toBe(25);
    expect(parseFaderIntent("bass hore +30%")?.percent).toBe(30);
  });

  it("808 inflections and hlasitosť noun match", () => {
    expect(parseFaderIntent("stíš 808s")?.targets).toContain("bass");
    expect(parseFaderIntent("urob 808ky hlasitejšie")?.direction).toBe("up");
    expect(parseFaderIntent("hlasitosť basov hore")?.targets).toContain("bass");
  });

  it("percent drives exact relative gain (10 % → ×1.10)", () => {
    const doc = testDoc();
    const commands = applyFaderIntent(doc, { targets: ["master"], direction: "up", percent: 10 });
    const next = commands[0].execute(doc);
    const before = doc.master?.masterGain ?? 1;
    expect(next.master?.masterGain).toBeCloseTo(before * 1.1, 2);
    const down = applyFaderIntent(doc, { targets: ["master"], direction: "down", percent: 10 })[0].execute(doc);
    expect(down.master?.masterGain).toBeCloseTo(before * 0.9, 2);
  });

  it("down 100 % mutes without going negative", () => {
    const doc = testDoc();
    const next = applyFaderIntent(doc, { targets: ["master"], direction: "down", percent: 100 })[0].execute(doc);
    expect(next.master?.masterGain).toBe(0);
  });
});

describe("fader amount modifiers + per-pad targets (GOAL 40)", () => {
  it("amount modifiers map to subtle / big / full", () => {
    expect(parseFaderIntent("zníž basu trochu")?.amount).toBe("subtle");
    expect(parseFaderIntent("zníž basu o dosť")?.amount).toBe("big");
    expect(parseFaderIntent("zníž basu úplne")?.amount).toBe("full");
    expect(parseFaderIntent("hlasnejšie bicie")?.amount).toBe("normal");
    // EN amounts
    expect(parseFaderIntent("turn down the drums a bit")?.amount).toBe("subtle");
    expect(parseFaderIntent("raise the bass a lot")?.amount).toBe("big");
  });

  it("per-pad targets: kick / haty / snare / clap", () => {
    expect(parseFaderIntent("kick ťažší")?.pads).toEqual(["kick"]);
    expect(parseFaderIntent("kick ťažší")?.direction).toBe("up");
    expect(parseFaderIntent("haty tichšie")?.pads).toEqual(["hat"]);
    expect(parseFaderIntent("haty tichšie")?.direction).toBe("down");
    expect(parseFaderIntent("snare hlasnejšie")?.pads).toEqual(["snare"]);
    expect(parseFaderIntent("clap hore")?.pads).toEqual(["clap"]);
    // no track target when only a pad family is named
    expect(parseFaderIntent("kick ťažší")?.targets).toEqual([]);
  });

  it("amount + pad together", () => {
    const intent = parseFaderIntent("kick o dosť ťažší");
    expect(intent?.pads).toEqual(["kick"]);
    expect(intent?.amount).toBe("big");
  });
});

describe("applyFaderIntent — amounts and pads", () => {
  const doc = testDoc();
  const drumTrack = doc.tracks.find(
    (track): track is Extract<(typeof doc.tracks)[number], { kind: "drum" }> => track.kind === "drum",
  );
  if (!drumTrack) throw new Error("fixture has no drum track");

  it("subtle amount steps less than normal", () => {
    const downNormal = applyFaderIntent(
      { ...doc, tracks: doc.tracks },
      { targets: ["master"], pads: [], direction: "down", amount: "normal" },
    )[0].execute(doc);
    const downSubtle = applyFaderIntent(
      { ...doc, tracks: doc.tracks },
      { targets: ["master"], pads: [], direction: "down", amount: "subtle" },
    )[0].execute(doc);
    expect(downSubtle.master?.masterGain).toBeGreaterThan(downNormal.master?.masterGain ?? 0);
    expect(downNormal.master?.masterGain).toBeLessThan(doc.master?.masterGain ?? 1);
  });

  it("per-pad gain: only matching family pads move", () => {
    const drum = drumTrack;
    const kickPad = drum.pads.find((pad) => inferPadRole(pad.name, drum.pads.indexOf(pad)) === "kick");
    expect(kickPad).toBeDefined();
    // "other" must be a pad OUTSIDE the kick family — house kits often ship
    // several kick-family pads, which legitimately move together
    const kickRole = inferPadRole(kickPad!.name, drum.pads.indexOf(kickPad!));
    const otherPad = drum.pads.find(
      (pad) => pad.id !== kickPad!.id && inferPadRole(pad.name, drum.pads.indexOf(pad)) !== kickRole,
    );
    const beforeKick = kickPad!.gain;
    const beforeOther = otherPad?.gain ?? 0;
    const commands = applyFaderIntent(doc, { targets: [], pads: ["kick"], direction: "up", amount: "big" });
    expect(commands.length).toBeGreaterThan(0);
    let next = doc;
    for (const command of commands) next = command.execute(next);
    const nextDrum = next.tracks.find((track): track is DrumTrack => track.kind === "drum");
    const afterKick = nextDrum?.pads.find((pad) => pad.id === kickPad!.id);
    const afterOther = nextDrum?.pads.find((pad) => pad.id === otherPad?.id);
    expect(afterKick?.gain).toBeGreaterThan(beforeKick);
    if (otherPad) {
      expect(afterOther?.gain).toBe(beforeOther);
    }
  });

  it("full amount down clamps at the gain floor", () => {
    const commands = applyFaderIntent(doc, {
      targets: ["master"],
      pads: [],
      direction: "down",
      amount: "full",
    });
    const next = commands[0].execute(doc);
    expect(next.master?.masterGain).toBeGreaterThanOrEqual(0);
  });
});
