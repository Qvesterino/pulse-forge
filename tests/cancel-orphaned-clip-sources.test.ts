import { describe, expect, it, vi } from "vitest";
import { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { ClipSourceMeta } from "../src/audio-engine/triggerEngine";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { addAudioClip } from "../src/commands/commands";

/**
 * AUDIT 01 follow-up — live-edit flush: `cancelOrphanedClipSources`.
 *
 * This closes the gap the first audit wave recorded as "needs a browser pass".
 * It does NOT: the flush is pure bookkeeping over the engine's own
 * `clipSourceMeta` map plus the current document, so it is reachable in
 * jsdom through the established `engine as unknown as {...}` seam that
 * `audio-engine-meter.test.ts` already uses. No WebAudio clock is needed —
 * `currentTime` reads `ctx?.currentTime ?? 0`, and the orphan path only needs
 * a non-negative timestamp.
 *
 * The contract under test (AudioEngine.ts:2818):
 *   - a source whose clip still exists with UNCHANGED geometry survives and is
 *     reported, so the resume pass can skip it;
 *   - a source whose clip was deleted, moved, resized, or muted is de-click
 *     cancelled: the envelope is ramped to zero (cancelScheduledValues first,
 *     so a scheduled fade cannot fight the ramp), then `stop(now + 0.05)`;
 *   - cancelled sources are dropped from `clipSourceMeta`;
 *   - a LIVE PAD voice is never treated as a clip orphan.
 */

type Internals = {
  clipSourceMeta: Map<unknown, ClipSourceMeta>;
  setProject: (doc: unknown) => void;
};

/** A source + gain node pair that records the calls the flush makes. */
function fakeSource() {
  const gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
  const stop = vi.fn();
  const gainNode = { gain } as unknown as GainNode;
  const source = { stop, disconnect: vi.fn() } as unknown as AudioScheduledSourceNode;
  return { source, gainNode, stop, gain };
}

/** Install a fake sounding source for `clipId` at the given geometry. */
function install(
  engine: AudioEngine,
  clipId: string,
  startBar: number,
  lengthBars: number,
  overrides: Partial<ClipSourceMeta> = {},
) {
  const internals = engine as unknown as Internals;
  const { source, gainNode, stop, gain } = fakeSource();
  const meta: ClipSourceMeta = {
    clipId,
    startBar,
    lengthBars,
    muted: false,
    gainNode,
    ...overrides,
  };
  internals.clipSourceMeta.set(source, meta);
  return { source, meta, stop, gain };
}

/** Engine loaded with one audio clip on an instrument track. */
function engineWithClip(clip: { id?: string; startBar?: number; lengthBars?: number } = {}) {
  const base = normalizeProject({ ...createProjectFromTemplate("house"), arrangement: { clips: [] } });
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const withClip = normalizeProject(
    addAudioClip(base, trackId, "buf", clip.startBar ?? 0, clip.lengthBars ?? 8, {}).execute(base),
  );
  const audioClip = withClip.arrangement.audioClips![0]!;
  const engine = new AudioEngine();
  (engine as unknown as Internals).setProject(withClip);
  return { engine, doc: withClip, clipId: clip.id ?? audioClip.id, audioClip };
}

describe("cancelOrphanedClipSources — live-edit flush (audit 01)", () => {
  it("keeps a still-sounding clip and reports it as a survivor (resume must not double-fire)", () => {
    const { engine, clipId, audioClip } = engineWithClip();
    const { stop } = install(engine, clipId, audioClip.startBar, audioClip.lengthBars);
    const survivors = engine.cancelOrphanedClipSources();
    expect([...survivors]).toEqual([clipId]);
    expect(stop, "a live clip's source must NOT be stopped").not.toHaveBeenCalled();
    expect((engine as unknown as Internals).clipSourceMeta.size).toBe(1);
  });

  it("cancels and drops the source when the clip was deleted", () => {
    const { engine, clipId, audioClip, doc } = engineWithClip();
    const { stop, gain } = install(engine, clipId, audioClip.startBar, audioClip.lengthBars);
    // The clip leaves the document (delete / undo of an add).
    const internals = engine as unknown as Internals;
    internals.setProject(
      normalizeProject({
        ...doc,
        arrangement: { ...doc.arrangement, audioClips: [] },
      }),
    );
    const survivors = engine.cancelOrphanedClipSources();
    expect(survivors.size).toBe(0);
    // De-click: ramp the envelope down, then hard-stop 50 ms later.
    expect(gain.cancelScheduledValues).toHaveBeenCalled();
    expect(gain.setTargetAtTime).toHaveBeenCalledWith(0, expect.any(Number), 0.004);
    expect(stop).toHaveBeenCalledWith(expect.any(Number));
    expect(internals.clipSourceMeta.size).toBe(0);
  });

  it("cancels the source when the clip moved (geometry changed)", () => {
    const { engine, clipId, audioClip } = engineWithClip();
    const { stop } = install(engine, clipId, audioClip.startBar + 4, audioClip.lengthBars); // meta says old spot
    const survivors = engine.cancelOrphanedClipSources();
    expect(survivors.size).toBe(0);
    expect(stop).toHaveBeenCalled();
  });

  it("cancels the source when the clip was resized", () => {
    const { engine, clipId, audioClip } = engineWithClip();
    const { stop } = install(engine, clipId, audioClip.startBar, audioClip.lengthBars + 4);
    expect(engine.cancelOrphanedClipSources().size).toBe(0);
    expect(stop).toHaveBeenCalled();
  });

  it("cancels a muted-while-sounding clip (mute must silence NOW, like a delete)", () => {
    const { engine, clipId, audioClip, doc } = engineWithClip();
    const { stop } = install(engine, clipId, audioClip.startBar, audioClip.lengthBars);
    // Muting filters the clip out of audioClipsForPlayback, so it is no longer live.
    const muted = normalizeProject({
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: doc.arrangement.audioClips!.map((c) => ({ ...c, muted: true })),
      },
    });
    (engine as unknown as Internals).setProject(muted);
    expect(engine.cancelOrphanedClipSources().size).toBe(0);
    expect(stop).toHaveBeenCalled();
  });

  it("never treats a LIVE PAD voice as a clip orphan", () => {
    const { engine } = engineWithClip();
    const { stop } = install(engine, "not-a-real-clip", 0, 4, { livePadVoiceId: "pad-1" });
    // A live pad source is not in the document at all — without the guard this
    // would be cancelled out from under a held pad.
    const survivors = engine.cancelOrphanedClipSources();
    expect(stop, "a live-pad source must not be stopped").not.toHaveBeenCalled();
    expect(survivors.size).toBe(0); // and it is NOT reported as a clip survivor either
    expect((engine as unknown as Internals).clipSourceMeta.size).toBe(1);
  });

  it("is a no-op with no sounding sources", () => {
    const { engine } = engineWithClip();
    expect(engine.cancelOrphanedClipSources().size).toBe(0);
  });

  it("separates survivors from orphans in one pass (mixed document)", () => {
    const { engine, doc, clipId, audioClip } = engineWithClip();
    // Two clips: one untouched, one moved.
    const secondId = "moved-clip";
    const internals = engine as unknown as Internals;
    const twoClips = normalizeProject({
      ...doc,
      arrangement: {
        ...doc.arrangement,
        audioClips: [...doc.arrangement.audioClips!, { ...audioClip, id: secondId, startBar: audioClip.startBar + 8 }],
      },
    });
    internals.setProject(twoClips);
    install(engine, clipId, audioClip.startBar, audioClip.lengthBars);
    const orphan = install(engine, secondId, audioClip.startBar, audioClip.lengthBars); // stale geometry
    const survivors = engine.cancelOrphanedClipSources();
    expect([...survivors]).toEqual([clipId]);
    expect(orphan.stop).toHaveBeenCalled();
    expect(internals.clipSourceMeta.size).toBe(1);
  });
});
