import { describe, expect, it } from "vitest";
import { clampTempo, createLinkCore } from "../server/link-core.mjs";
import {
  LinkSync,
  defaultLinkUrl,
  isLinkFrame,
  linkBeatAt,
  linkCorrection,
  phaseDistance,
  type LinkFrame,
} from "../src/collab/linkSync";

/**
 * Ableton Link over the WS bridge — session clock + client phase-lock math.
 *
 * The bridge core is the session authority (tempo-integrated absolute beat,
 * continuity-preserving tempo rebases); the client extrapolates frames and
 * phase-locks the transport. Both sides are pure math, so the whole protocol
 * contract is pinned here without opening a socket.
 */

function frame(overrides: Partial<LinkFrame> = {}): LinkFrame {
  return { type: "link", tempo: 120, beat: 0, playing: false, quantum: 4, peers: 1, at: 1000, ...overrides };
}

describe("link bridge core (server/link-core.mjs)", () => {
  it("clamps tempo into the Link range and rejects garbage", () => {
    expect(clampTempo(128)).toBe(128);
    expect(clampTempo(0.5)).toBe(20);
    expect(clampTempo(999)).toBe(300);
    expect(clampTempo(Number.NaN)).toBeNull();
    expect(clampTempo("120" as unknown as number)).toBeNull();
  });

  it("integrates the absolute beat from tempo over wall time", () => {
    let t = 1000;
    const core = createLinkCore({ now: () => t });
    expect(core.frame().beat).toBe(0);
    t += 5000; // 5 s at 120 BPM = 10 beats
    expect(core.frame().beat).toBeCloseTo(10, 6);
    expect(core.frame().at).toBe(t);
  });

  it("keeps the beat counter continuous through a tempo rebase", () => {
    let t = 1000;
    const core = createLinkCore({ now: () => t });
    t += 15_000; // 30 beats at 120 BPM
    core.applyClientState({ tempo: 60 });
    t += 15_000; // 15 more beats at 60 BPM (1 beat/s)
    expect(core.frame().beat).toBeCloseTo(45, 6);
    expect(core.frame().tempo).toBe(60);
  });

  it("caps integration so a stalled clock cannot fling the phase", () => {
    let t = 1000;
    const core = createLinkCore({ now: () => t });
    t += 10 * 60_000; // 10 minutes away
    // 60 s integration cap at 120 BPM = 120 beats, not 1200.
    expect(core.frame().beat).toBeCloseTo(120, 6);
  });

  it("arbitrates last-writer-wins and counts peers", () => {
    let t = 1000;
    const core = createLinkCore({ now: () => t });
    core.touchPeer("a", "KYX");
    core.touchPeer("b", "KYX");
    core.applyClientState({ playing: true });
    expect(core.frame().peers).toBe(2);
    expect(core.frame().playing).toBe(true);
    core.dropPeer("a");
    expect(core.peerCount).toBe(1);
    // Garbage state is ignored, not poisoned.
    core.applyClientState({ tempo: Number.NaN, playing: "yes" as unknown as boolean });
    expect(core.tempo).toBe(120);
    expect(core.playing).toBe(true);
  });

  it("coerces native Link state through the same LWW path", () => {
    let t = 1000;
    const core = createLinkCore({ now: () => t });
    core.applyNativeState({ tempo: 174, playing: 1 });
    expect(core.tempo).toBe(174);
    expect(core.playing).toBe(true);
  });
});

describe("link client math (src/collab/linkSync.ts)", () => {
  it("validates frames at the network boundary", () => {
    expect(isLinkFrame(frame())).toBe(true);
    expect(isLinkFrame({ ...frame(), type: "state" })).toBe(false);
    expect(isLinkFrame({ ...frame(), tempo: 500 })).toBe(false);
    expect(isLinkFrame({ ...frame(), beat: Number.NaN })).toBe(false);
    expect(isLinkFrame({ ...frame(), quantum: 0 })).toBe(false);
    expect(isLinkFrame({ ...frame(), at: "soon" })).toBe(false);
    expect(isLinkFrame(null)).toBe(false);
  });

  it("extrapolates the session beat between frames, clamping stale clocks", () => {
    const f = frame({ tempo: 120, beat: 10, at: 1000 });
    expect(linkBeatAt(f, 6000)).toBeCloseTo(20, 6);
    // Sample from the future (clock skew) — no time travel.
    expect(linkBeatAt(f, 500)).toBe(10);
    // An hour-old frame advances at most a minute of beats.
    expect(linkBeatAt(f, 1000 + 3_600_000)).toBeCloseTo(10 + 120, 6);
  });

  it("wraps phase distance to the shorter direction", () => {
    expect(phaseDistance(0.5, 0, 4)).toBeCloseTo(0.5, 9);
    expect(phaseDistance(3.75, 0, 4)).toBeCloseTo(0.25, 9);
    expect(phaseDistance(5, 0, 4)).toBeCloseTo(1, 9);
    expect(phaseDistance(-1, 0, 4)).toBeCloseTo(1, 9);
    // Degenerate quantum falls back to 4 instead of dividing by zero.
    expect(phaseDistance(1, 0, 0)).toBe(1);
  });

  it("decides corrections: snap off-phase playheads, adopt foreign tempo", () => {
    const f = frame({ tempo: 128, beat: 100, at: 1000 });
    // Phase-tight but playing at a different tempo — tempo adoption fires
    // even when the phase needs no snap.
    const tight = linkCorrection(100, 120, f, 1000);
    expect(tight.snap).toBe(false);
    expect(tight.tempo).toBe(128);
    // Half a beat late (quantum 4 → distance 0.5) — hard snap.
    const late = linkCorrection(100.5, 128, f, 1000);
    expect(late.snap).toBe(true);
    expect(late.sessionBeat).toBeCloseTo(100, 9);
    // Within the snap threshold (0.2 < 0.25) but wrong tempo — tempo only.
    const drifting = linkCorrection(100.2, 120, f, 1000);
    expect(drifting.snap).toBe(false);
    expect(drifting.tempo).toBe(128);
    // Tempo echo of our own value — no adoption.
    const echoed = linkCorrection(100, 120, frame({ beat: 100 }), 1000);
    expect(echoed.tempo).toBeNull();
  });

  it("derives the bridge URL from the page host", () => {
    expect(defaultLinkUrl()).toBe(`ws://${location.hostname}:20909`);
  });

  it("rejects non-same-host bridge URLs before any socket exists", () => {
    const sync = new LinkSync({ now: () => 0 });
    const seen: unknown[] = [];
    sync.subscribe((s) => seen.push(s));
    sync.connect("wss://evil.example:20909");
    expect(sync.enabled).toBe(false);
    expect(sync.status.kind).toBe("error");
    expect(seen.some((s) => (s as { kind: string }).kind === "error")).toBe(true);
    sync.dispose();
  });

  it("dispose without a connection is a no-op", () => {
    const sync = new LinkSync({ now: () => 0 });
    expect(() => sync.dispose()).not.toThrow();
  });
});
