import { describe, expect, it, vi } from "vitest";
import { MelodicKeys } from "../../src/ui/melodicKeys";

function key(code: string, over: Record<string, unknown> = {}) {
  return { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: null, ...over };
}

function makePlayer(trackId: string | null = "track-inst") {
  const engine = {
    currentTime: 1.25,
    noteOn: vi.fn(),
    noteOff: vi.fn(),
  };
  const player = new MelodicKeys();
  player.bind({ engine: engine as unknown as never, getInstrumentTrackId: () => trackId });
  return { player, engine };
}

describe("melodic QWERTY player", () => {
  it("maps the tracker layout: A=C4, W=C#4, K=C5, ;=E5", () => {
    const { player, engine } = makePlayer();
    player.keydown(key("KeyA"));
    player.keydown(key("KeyW"));
    player.keydown(key("KeyK"));
    player.keydown(key("Semicolon"));
    const pitches = engine.noteOn.mock.calls.map((c) => c[1]);
    expect(pitches).toEqual([60, 61, 72, 76]);
  });

  it("keys sustain (long duration) and key-up releases the same pitch via noteOff", () => {
    const { player, engine } = makePlayer();
    player.keydown(key("KeyF"));
    expect(engine.noteOn).toHaveBeenCalledTimes(1);
    const [, pitch, velocity, , duration] = engine.noteOn.mock.calls[0];
    expect(velocity).toBeCloseTo(0.8, 5);
    expect(duration).toBeGreaterThan(1); // held until key-up for noteOff runtimes

    player.keyup(key("KeyF"));
    expect(engine.noteOff).toHaveBeenCalledWith("track-inst", pitch, 1.255);
  });

  it("Z/X shift the octave with clamping; held keys release their original pitch", () => {
    const { player, engine } = makePlayer();
    expect(player.keydown(key("KeyX"))).toBe(true);
    player.keydown(key("KeyA"));
    expect(engine.noteOn.mock.calls.at(-1)![1]).toBe(72); // C5
    player.keyup(key("KeyA"));
    expect(engine.noteOff.mock.calls.at(-1)![1]).toBe(72);

    player.keydown(key("KeyZ"));
    player.keydown(key("KeyA"));
    expect(engine.noteOn.mock.calls.at(-1)![1]).toBe(60); // back to C4

    // clamp: 3 octave-ups past the max do not escape 0..127
    for (let i = 0; i < 6; i++) player.keydown(key("KeyX"));
    player.keydown(key("KeyK")); // would be 60 + 12*4 + 12 = 120 → fine
    expect(engine.noteOn.mock.calls.at(-1)![1]).toBeLessThanOrEqual(127);
  });

  it("ignores key repeat, modifiers, typing targets and non-instrument tracks", () => {
    const { player, engine } = makePlayer();
    expect(player.keydown(key("KeyA", { repeat: true }))).toBe(false);
    expect(player.keydown(key("KeyA", { ctrlKey: true }))).toBe(false);
    expect(player.keydown(key("KeyA", { target: { tagName: "INPUT" } }))).toBe(false);
    expect(engine.noteOn).not.toHaveBeenCalled();

    const drum = makePlayer(null); // drum track selected — pads own the letters
    expect(drum.player.keydown(key("KeyA"))).toBe(false);
    expect(drum.engine.noteOn).not.toHaveBeenCalled();
  });

  it("a held key does not double-trigger; unknown keys are not consumed", () => {
    const { player, engine } = makePlayer();
    expect(player.keydown(key("KeyH"))).toBe(true);
    expect(player.keydown(key("KeyH"))).toBe(true); // already sounding
    expect(engine.noteOn).toHaveBeenCalledTimes(1);

    expect(player.keydown(key("Digit1"))).toBe(false); // not a melodic key
    player.keyup(key("KeyH"));
    expect(engine.noteOff).toHaveBeenCalledTimes(1);
  });
});
