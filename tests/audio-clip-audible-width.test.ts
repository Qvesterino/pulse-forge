import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  audioClipAudibleWidthFraction,
  audioClipPlayedSourceSec,
  audioClipWallSourceSec,
} from "../src/project-model/audio-clip-warp";
import { audioClipPlayWindow } from "../src/audio-engine/warpManager";
import type { AudioClip } from "../src/project-model/types";

/**
 * A CLIP LONGER THAN ITS SOURCE — the envelope must not paint over the silence.
 *
 * THE DEFECT (P2, visual/state mismatch). The engine plays
 * `min(wall length × factor, source that is left)` seconds of the original
 * sample; when the clip is longer than its source, the engine plays the source
 * and then NOTHING. The waveform stretched the source window across the clip's
 * FULL width, so the envelope was drawn over that silent tail — the picture
 * said "sound here" where the transport plays silence.
 *
 * F12 fixed the AMOUNT of source the envelope covers; this fixes WHERE that
 * material sits on the clip's width.
 *
 * THE RULE, WITH THE ENGINE AS THE ORACLE. The material occupies the first
 * `played / factor` wall seconds of the clip, so it covers
 * `played / (wall × factor)` of the clip's width. The engine's own
 * `duration / requestedDuration` says the same thing from the other side:
 * the fraction of the clip's wall duration that actually plays. The two must
 * agree — that equality IS the invariant.
 */

const SOURCE_SEC = 10;

function clip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "c1",
    trackId: "t1",
    bufferId: "b1",
    startBar: 0,
    lengthBars: 2,
    offsetSec: 0,
    trimStart: 0,
    trimEnd: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    stretchRate: 1,
    reverse: false,
    ...overrides,
  };
}

describe("a clip longer than its source leaves the silent tail blank", () => {
  it("a clip shorter than its source covers its whole width", () => {
    const c = clip();
    const wallSec = 4;
    const played = audioClipPlayedSourceSec(c, SOURCE_SEC, wallSec);
    const wallSource = audioClipWallSourceSec(c, wallSec);
    expect(played).toBeCloseTo(4, 6);
    expect(audioClipAudibleWidthFraction(played, wallSource)).toBeCloseTo(1, 6);
  });

  it("a clip longer than its source covers only the part that plays", () => {
    const c = clip();
    const wallSec = 20; // twice the source
    const played = audioClipPlayedSourceSec(c, SOURCE_SEC, wallSec);
    const wallSource = audioClipWallSourceSec(c, wallSec);

    expect(played, "the clip plays the whole source and then nothing").toBeCloseTo(SOURCE_SEC, 6);
    expect(wallSource, "the clip's wall length corresponds to more source than it has").toBeCloseTo(20, 6);
    expect(audioClipAudibleWidthFraction(played, wallSource)).toBeCloseTo(0.5, 6);
  });

  it("the fraction agrees with the engine — the picture is the sound", () => {
    for (const wallSec of [2, 4, 10, 20, 40]) {
      const c = clip();
      const played = audioClipPlayedSourceSec(c, SOURCE_SEC, wallSec);
      const fraction = audioClipAudibleWidthFraction(played, audioClipWallSourceSec(c, wallSec));
      const win = audioClipPlayWindow(c, SOURCE_SEC, wallSec, 1);
      expect(
        win.duration / wallSec,
        `the fraction of the width that carries material must equal the fraction of the clip that plays (wall ${wallSec}s)`,
      ).toBeCloseTo(fraction, 6);
    }
  });

  it("a trimmed tail is silence too", () => {
    // 2 s trimmed off the source's end: the clip plays 8 s of material and
    // then silence, so the envelope must stop at 8/10 of the width.
    const c = clip({ trimEnd: 2 });
    const wallSec = 10;
    const played = audioClipPlayedSourceSec(c, SOURCE_SEC, wallSec);
    const fraction = audioClipAudibleWidthFraction(played, audioClipWallSourceSec(c, wallSec));
    expect(played).toBeCloseTo(8, 6);
    expect(fraction).toBeCloseTo(0.8, 6);
  });

  it("the degenerate inputs do not produce a NaN width", () => {
    expect(audioClipAudibleWidthFraction(4, 0)).toBe(1);
    expect(audioClipAudibleWidthFraction(4, Number.NaN)).toBe(1);
    expect(audioClipAudibleWidthFraction(0, 4)).toBe(0);
    expect(audioClipAudibleWidthFraction(-1, 4)).toBe(0);
    expect(audioClipAudibleWidthFraction(8, 4)).toBe(1);
  });

  it("the arrangement panel passes the wall-source span to the waveform", () => {
    const panel = readFileSync(resolve(process.cwd(), "src/ui/ArrangementPanel.tsx"), "utf8");
    expect(panel).toContain("audioClipAudibleWidthFraction(");
    expect(panel).toContain("audioClipWallSourceSec(");
    // The envelope's x positions are scaled by the fraction, and so are the
    // transient ticks — otherwise the onset dots would sit outside the
    // material they belong to.
    expect((panel.match(/audibleFraction/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((panel.match(/envelopeWidth/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
