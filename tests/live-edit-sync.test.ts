import { describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { normalizeProject } from "../src/project-model/schema";
import { BAR_TICKS, PPQ, type ProjectDocument } from "../src/project-model/types";
import { addAudioClip } from "../src/commands/commands";
import { resumeSpanningAudioClips, syncDocChangeWhilePlaying } from "../src/audio-engine/liveEditSync";
import type { AudioEngine } from "../src/audio-engine/AudioEngine";
import type { Transport } from "../src/transport/Transport";

/**
 * AUDIT 01 — Editing & Timeline: live-editing sync.
 *
 * `resumeSpanningAudioClips` is the module that decides what you HEAR after an
 * edit or a seek while the transport runs. Two failure modes matter and they
 * are opposite: a clip that keeps sounding after it was deleted/moved
 * (orphaned sound), and a clip that is present under the playhead but never
 * triggered (silent present). Both were previously unverified by vitest — the
 * only driver was the browser pass.
 *
 * These tests pin the decision logic with a recording fake, so a regression is
 * caught in the normal suite rather than only in a browser run.
 */

function docWithAudio(): { doc: ProjectDocument; trackId: string; clipId: string } {
  const base = normalizeProject({
    ...createProjectFromTemplate("house"),
    arrangement: { clips: [] },
  });
  // Audio clips are routed onto an instrument track — `Track` has no "audio"
  // kind (DrumTrack | InstrumentTrack | GroupTrack | GenerativeTrack).
  const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
  const next = addAudioClip(base, trackId, "bufLive", 0, 8, {}).execute(base);
  const clipId = next.arrangement.audioClips![0]!.id;
  return { doc: normalizeProject(next), trackId, clipId };
}

/**
 * Engine + transport fakes that RECORD what would have been triggered.
 *
 * `positionTicks` — Transport.position is in TICKS, not seconds
 * (Transport.ts:107 returns tickAt(clock.now())). Passing seconds here makes
 * every spanning-clip comparison wrong by a factor of secondsPerTick, so the
 * fake mirrors the real units exactly.
 */
function harness(doc: ProjectDocument, positionTicks: number) {
  const triggered: Array<{
    clipId: string;
    when: number;
    durationSec?: number;
    resumeOffsetSec: number;
    clip: unknown;
  }> = [];
  const engine = {
    currentTime: 1,
    cancelOrphanedClipSources: () => new Set<string>(),
    triggerAudioClip: (clip: { id: string }, when: number, durationSec?: number, resumeOffsetSec = 0) => {
      triggered.push({ clipId: clip.id, when, durationSec, resumeOffsetSec, clip });
    },
  } as unknown as AudioEngine;
  const transport = { position: positionTicks, secondsPerTick: 60 / (doc.bpm * PPQ) } as unknown as Transport;
  const deps = { engine, transport, getDoc: () => doc };
  return { triggered, deps };
}

/** Ticks at the given bar. */
const atBar = (bar: number): number => bar * BAR_TICKS;

describe("live-edit sync — resumeSpanningAudioClips (audit 01)", () => {
  it("resumes a clip that spans the playhead, with the source offset advanced by exactly the elapsed source time", () => {
    const { doc, clipId } = docWithAudio();
    const clip = doc.arrangement.audioClips![0]!;
    // playhead at bar 4 of an 8-bar clip at 120bpm = 8 wall seconds in
    const posTicks = atBar(4);
    const posSec = (posTicks * 60) / (doc.bpm * PPQ); // 4 bars * 4 beats * 0.5s
    const { triggered, deps } = harness(doc, posTicks);
    resumeSpanningAudioClips(deps);
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.clipId).toBe(clipId);
    // The resumed clip starts AT the playhead and carries the source position
    // reached so far — otherwise playback would restart the clip from its head
    // inside a seek (the classic "stutter on seek" defect).
    expect(triggered[0]!.resumeOffsetSec).toBeGreaterThan(0);
    // NEGATIVE-CONTROL-SAFE assertion: the expected source position is COMPUTED
    // from the tempo law, not bounded by the clip's own starting offset. The
    // weaker `offsetSec >= clip.offsetSec` passes even when the resume math is
    // deleted entirely (verified: mutating the source to `+ 0 * elapsedSec`
    // still satisfied that form) because the fresh clip's offsetSec is 0.
    expect((triggered[0]!.clip as { offsetSec: number }).offsetSec).toBeCloseTo(
      (clip.offsetSec ?? 0) + posSec * (clip.stretchRate ?? 1),
      3,
    );
    // And the resumed geometry must be anchored at the playhead, not the clip head.
    const resumed = triggered[0]!.clip as { startBar: number; lengthBars: number };
    expect(resumed.startBar).toBeCloseTo(posTicks / BAR_TICKS, 6);
    expect(resumed.lengthBars).toBeCloseTo(clip.lengthBars - posTicks / BAR_TICKS, 6);
    // durationSec handed to the engine is the REMAINING wall time, not the
    // whole clip — otherwise a resumed tail keeps sounding past the clip end.
    const clipEndSec = (clip.startBar + clip.lengthBars * 1 * (BAR_TICKS / BAR_TICKS)) * 0;
    void clipEndSec;
    expect(triggered[0]!.durationSec).toBeCloseTo(posSec, 3);
  });

  it("does NOT resume a clip that is entirely in the future — the scheduler owns it", () => {
    const { doc } = docWithAudio();
    const { triggered, deps } = harness(doc, 0); // playhead at bar 0, clip ends == pos
    resumeSpanningAudioClips(deps);
    expect(triggered).toHaveLength(0);
  });

  it("does not resume a clip whose start is far past the playhead", () => {
    const base = normalizeProject({
      ...createProjectFromTemplate("house"),
      arrangement: { clips: [] },
    });
    const trackId = base.tracks.find((t) => t.kind === "instrument")!.id;
    const next = addAudioClip(base, trackId, "bufFar", 8, 4, {}).execute(base);
    const doc = normalizeProject(next);
    const { triggered, deps } = harness(doc, atBar(0));
    resumeSpanningAudioClips(deps);
    expect(triggered).toHaveLength(0);
  });

  it("skips survivor ids so a still-sounding clip is never double-triggered", () => {
    const { doc, clipId } = docWithAudio();
    const { triggered, deps } = harness(doc, atBar(2));
    resumeSpanningAudioClips({ ...deps, skipIds: new Set([clipId]) });
    expect(triggered).toHaveLength(0);
  });

  it("never resumes reverse, looping, warped or pitch-preserving-stretch clips (resume math does not exist for them)", () => {
    const variants = [
      { name: "reverse", patch: { reverse: true } },
      { name: "loop", patch: { loop: true } },
      { name: "warped", patch: { warpMarkers: [{ timeSec: 0, tick: 0 }] } },
      { name: "preserving stretch", patch: { stretchMode: "stretch" as const, stretchRate: 2 } },
    ];
    for (const variant of variants) {
      const { doc } = docWithAudio();
      const next = {
        ...doc,
        arrangement: {
          ...doc.arrangement,
          audioClips: doc.arrangement.audioClips!.map((c, i) => (i === 0 ? { ...c, ...variant.patch } : c)),
        },
      } as ProjectDocument;
      const { triggered, deps } = harness(next, atBar(2));
      resumeSpanningAudioClips(deps);
      expect(triggered, `variant ${variant.name}`).toHaveLength(0);
    }
  });

  it("tolerates a bare/minimal document and a zero or negative playhead without throwing", () => {
    const bare = { bpm: 120, scenes: [] } as unknown as ProjectDocument;
    const engine = {
      currentTime: 0,
      cancelOrphanedClipSources: () => new Set<string>(),
      triggerAudioClip: () => {
        throw new Error("must not trigger on a bare doc");
      },
    } as unknown as AudioEngine;
    const transport = { position: 0, secondsPerTick: 0.01 } as unknown as Transport;
    expect(() => resumeSpanningAudioClips({ engine, transport, getDoc: () => bare })).not.toThrow();
    const { triggered, deps } = harness(bare, -5);
    expect(() => resumeSpanningAudioClips(deps)).not.toThrow();
    expect(triggered).toHaveLength(0);
  });

  it("syncDocChangeWhilePlaying flushes orphans first and then resumes the survivors' peers", () => {
    const { doc, clipId } = docWithAudio();
    const cancel = vi.fn(() => new Set<string>());
    const triggered: Array<{ clipId: string }> = [];
    const engine = {
      currentTime: 1,
      cancelOrphanedClipSources: cancel,
      triggerAudioClip: (clip: { id: string }) => {
        triggered.push({ clipId: clip.id });
      },
    } as unknown as AudioEngine;
    const transport = { position: atBar(2), secondsPerTick: 60 / (doc.bpm * PPQ) } as unknown as Transport;
    syncDocChangeWhilePlaying({ engine, transport, getDoc: () => doc });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(triggered.map((t) => t.clipId)).toContain(clipId);
  });
});
