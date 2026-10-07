import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GhostPreviewPlayer, GHOST_VOICE_OWNER } from "../src/audio-engine/GhostPreviewPlayer";
import { TriggerEngine } from "../src/audio-engine/triggerEngine";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { Pattern, ProjectDocument } from "../src/project-model/types";
import { PPQ } from "../src/project-model/types";

/**
 * Live-editing audio sync (ADR 0024) — the transient-player half.
 *
 * GhostPreviewPlayer.stop() used to only clear its scheduling timer: the last
 * lookahead window's events were already committed to the WebAudio clock and
 * kept sounding (plus every sustained note's full durSec). Now every ghost
 * voice is tagged via engine.withVoiceOwner(GHOST_VOICE_OWNER) and stop()
 * de-click-kills exactly that owner's voices — live-transport sound is
 * untagged and never matched.
 */

const ENGINE = resolve(process.cwd(), "src/audio-engine/AudioEngine.ts");
const TRIGGER = resolve(process.cwd(), "src/audio-engine/triggerEngine.ts");

function fakeEngine() {
  const mock = {
    currentTime: 0,
    ensureContext: vi.fn(),
    transportStarted: vi.fn(),
    trigger: vi.fn(),
    noteOn: vi.fn(),
    stopVoicesForOwner: vi.fn(),
    withVoiceOwner: vi.fn((_owner: string, fn: () => void) => fn()),
  };
  return { mock, engine: mock as unknown as AudioEngine };
}

function ghostPattern(doc: ProjectDocument): Pattern {
  const drum = doc.tracks.find((t) => t.kind === "drum");
  const inst = doc.tracks.find((t) => t.kind === "instrument");
  const padId = drum?.kind === "drum" ? (drum.pads[0]!.id ?? "") : "";
  return {
    id: "ghost-pattern-test",
    name: "ghost",
    stepCount: 16,
    rows: padId ? { [padId]: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } : {},
    notes: inst ? { [inst.id]: [{ id: "n1", pitch: 60, start: 0, duration: PPQ * 2, velocity: 0.8 }] } : {},
  };
}

describe("GhostPreviewPlayer owner-scoped voices (ADR 0024)", () => {
  it("scheduling windows tag their voices and stop() kills the overhang", () => {
    const doc = createProjectFromTemplate("house");
    const { mock, engine } = fakeEngine();
    const player = new GhostPreviewPlayer(engine, {} as never, () => doc);

    player.play(ghostPattern(doc));
    // play() opens with stop() (kill #0 — nothing scheduled yet), so clear
    // the slate before asserting the explicit stop's kill.
    mock.stopVoicesForOwner.mockClear();
    expect(player.isPlaying).toBe(true);

    player.stop();
    expect(player.isPlaying).toBe(false);
    // Pre-fix stop() made no engine call at all — the committed window kept
    // sounding. The kill is owner-scoped: exactly the ghost tag, once.
    expect(mock.stopVoicesForOwner).toHaveBeenCalledTimes(1);
    expect(mock.stopVoicesForOwner).toHaveBeenCalledWith(GHOST_VOICE_OWNER);
  });

  it("stop() before any play is a safe no-op kill (no context required)", () => {
    const doc = createProjectFromTemplate("house");
    const { mock, engine } = fakeEngine();
    const player = new GhostPreviewPlayer(engine, {} as never, () => doc);
    expect(() => player.stop()).not.toThrow();
    expect(mock.stopVoicesForOwner).toHaveBeenCalledWith(GHOST_VOICE_OWNER);
    expect(mock.ensureContext).not.toHaveBeenCalled();
  });

  it("every trigger/noteOn happens inside the owner scope, not outside it", () => {
    const doc = createProjectFromTemplate("house");
    const { mock, engine } = fakeEngine();
    // Scope recorder: any trigger/noteOn while no scope is open is a leak.
    let scopeDepth = 0;
    mock.withVoiceOwner.mockImplementation((_owner: string, fn: () => void) => {
      scopeDepth++;
      try {
        fn();
      } finally {
        scopeDepth--;
      }
    });
    const leak = vi.fn();
    mock.trigger.mockImplementation(() => leak(scopeDepth));
    mock.noteOn.mockImplementation(() => leak(scopeDepth));

    const player = new GhostPreviewPlayer(engine, {} as never, () => doc);
    player.play(ghostPattern(doc));
    expect(mock.trigger.mock.calls.length + mock.noteOn.mock.calls.length).toBeGreaterThan(0);
    // Every scheduling call observed depth 1 (open scope); never 0 (leak) or
    // deeper (accidental nesting). The first window may repeat across ticks.
    expect(leak.mock.calls.length).toBeGreaterThan(0);
    expect(new Set(leak.mock.calls.map((call) => call[0]))).toEqual(new Set([1]));
  });
});

describe("TriggerEngine owner scope (ADR 0024)", () => {
  it("stopVoicesForOwner de-clicks and removes ONLY the owner's voices", () => {
    const te = new TriggerEngine({ ctx: () => null } as never, { isFrozen: () => false } as never);
    const registry = te as unknown as {
      voices: Set<{
        owner?: string;
        source: { stop: ReturnType<typeof vi.fn> };
        gain: {
          gain: { cancelScheduledValues: ReturnType<typeof vi.fn>; setTargetAtTime: ReturnType<typeof vi.fn> };
          disconnect: ReturnType<typeof vi.fn>;
        };
        trackId: string;
        chokeGroup: null;
      }>;
    };
    const makeVoice = (owner?: string) => ({
      owner,
      source: { stop: vi.fn() },
      gain: { gain: { cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() }, disconnect: vi.fn() },
      trackId: "t",
      chokeGroup: null,
    });
    const ghost = makeVoice(GHOST_VOICE_OWNER);
    const live = makeVoice(undefined);
    const other = makeVoice("some-other-player");
    registry.voices.add(ghost as never);
    registry.voices.add(live as never);
    registry.voices.add(other as never);

    te.stopVoicesForOwner(GHOST_VOICE_OWNER, 5);

    // De-click idiom (same ramp as panicVoices), then the stop past the ramp.
    expect(ghost.gain.gain.cancelScheduledValues).toHaveBeenCalledWith(5);
    expect(ghost.gain.gain.setTargetAtTime).toHaveBeenCalledWith(0, 5, 0.008);
    expect(ghost.source.stop).toHaveBeenCalledWith(5.05);
    // Untagged (scheduler/live) and foreign-owner voices are untouched.
    expect(live.source.stop).not.toHaveBeenCalled();
    expect(other.source.stop).not.toHaveBeenCalled();
    expect(registry.voices.has(ghost as never)).toBe(false);
    expect(registry.voices.has(live as never)).toBe(true);
    expect(registry.voices.has(other as never)).toBe(true);
  });

  it("source pins: scoped tag API, owner stamping on both voice sites, engine delegates", () => {
    const src = readFileSync(TRIGGER, "utf8");
    expect(src).toMatch(/withVoiceOwner<T>\(owner: string, fn: \(\) => T\): T/);
    expect(src).toMatch(/stopVoicesForOwner\(owner: string, now: number\): void/);
    expect(src).toMatch(/voice\.owner !== owner/);
    // Both TriggerVoice construction sites (drum sample + synth finishVoice)
    // stamp the pending owner.
    expect(
      src.match(/\.\.\.\(this\.pendingVoiceOwner !== undefined \? \{ owner: this\.pendingVoiceOwner \} : \{\}\)/g)
        ?.length,
    ).toBe(2);
    const engine = readFileSync(ENGINE, "utf8");
    expect(engine).toMatch(/this\.triggerEngine\.withVoiceOwner\(owner, fn\)/);
    expect(engine).toMatch(/this\.triggerEngine\.stopVoicesForOwner\(owner, this\.currentTime\)/);
  });
});
