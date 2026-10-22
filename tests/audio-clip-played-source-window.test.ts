import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { audioClipWaveformWindow } from "../src/audio-engine/audioClipChannels";
import { audioClipPlayWindow } from "../src/audio-engine/warpManager";
import { audioClipPlayedSourceSec } from "../src/project-model/audio-clip-warp";
import type { AudioClip } from "../src/project-model/types";

/**
 * THE PICTURE MUST BE THE SOUND — an audio clip's waveform must show exactly
 * the source the clip plays.
 *
 * THE DEFECT (P2, visual/state mismatch). The engine plays
 * `min(wall length × factor, source that is left)` seconds of the ORIGINAL
 * sample (`audioClipPlayWindow`). The waveform drew the WHOLE remaining source
 * (`audioClipWaveformWindow` ended at `duration − trimEnd`) and stretched it
 * across the clip's full pixel width. So any clip shorter than its source —
 * which is what a right-edge trim produces, because `resizeAudioClip` only
 * rewrites `lengthBars` — drew the tail of the file that is never heard. The
 * picture and the sound disagreed, and the envelope the user edits against was
 * not the envelope they hear.
 *
 * THE RULE THIS PINS. Three links, each guarded:
 *
 *   1. `audioClipPlayedSourceSec` — the clip's wall length converted to source
 *      seconds, capped by the source that is left — must equal what the ENGINE
 *      plays (`audioClipPlayWindow` is the oracle, not a second copy of the
 *      rule).
 *   2. `audioClipWaveformWindow` must stop at that cap.
 *   3. The arrangement panel must pass the cap at every call site.
 *
 * The factor (`rate` for resample, `1 / rate` for pitch-preserving stretch)
 * is the repo's one owner (`audioClipSourceSecondsPerWallSecond`); this test
 * pins that the same factor reaches the picture.
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

/**
 * What the ENGINE plays, in ORIGINAL-sample seconds, derived from the engine's
 * own window resolver — never from a second copy of the rule.
 */
function enginePlayedSourceSec(c: AudioClip, wallSec: number): number {
  const rate = Math.min(4, Math.max(0.25, c.stretchRate ?? 1));
  const preStretched = c.stretchMode === "stretch" && Math.abs(rate - 1) >= 0.01;
  // The stretch branch plays a PRE-RENDERED buffer that is `rate` × the
  // original (`renderStretchedAudioBuffer`), so its timeline is scaled.
  const timeScale = preStretched ? rate : 1;
  const win = audioClipPlayWindow(c, SOURCE_SEC * timeScale, wallSec, timeScale);
  // A forward-looping clip repeats its whole trimmed region: every second of
  // it plays (`audioClipPlayWindow`: loopingForward).
  const looping = c.loop === true && c.reverse !== true;
  return (looping ? win.contentDur : win.bufferDuration) / timeScale;
}

const CASES: Array<{ name: string; clip: AudioClip; wallSec: number }> = [
  { name: "a clip shorter than its source", clip: clip(), wallSec: 4 },
  { name: "a resample clip at rate 2", clip: clip({ stretchRate: 2 }), wallSec: 4 },
  {
    name: "a pitch-preserving stretch clip at rate 2",
    clip: clip({ stretchRate: 2, stretchMode: "stretch" }),
    wallSec: 4,
  },
  {
    name: "a clip with a source offset and trims",
    clip: clip({ offsetSec: 2, trimStart: 1, trimEnd: 0.5 }),
    wallSec: 4,
  },
  { name: "a looping clip", clip: clip({ loop: true }), wallSec: 4 },
  { name: "a clip longer than its source", clip: clip(), wallSec: 20 },
  { name: "a reversed clip", clip: clip({ reverse: true }), wallSec: 4 },
];

describe("the waveform shows exactly the source the clip plays", () => {
  it("audioClipPlayedSourceSec exists — the one owner of the played-source rule", () => {
    expect(typeof audioClipPlayedSourceSec).toBe("function");
  });

  for (const { name, clip: c, wallSec } of CASES) {
    it(`${name}: the played source matches the engine`, () => {
      expect(typeof audioClipPlayedSourceSec).toBe("function");
      const played = audioClipPlayedSourceSec(c, SOURCE_SEC, wallSec);
      expect(played).toBeCloseTo(enginePlayedSourceSec(c, wallSec), 6);
    });

    it(`${name}: the drawn window stops where the sound stops`, () => {
      const played = enginePlayedSourceSec(c, wallSec);
      const drawn = audioClipWaveformWindow(SOURCE_SEC, c.offsetSec ?? 0, c.trimStart ?? 0, c.trimEnd ?? 0, played);
      // The envelope must not be longer than the material that plays.
      expect(drawn.endSec - drawn.startSec).toBeCloseTo(played, 6);
      // …and it must start where playback starts.
      expect(drawn.startSec).toBeCloseTo((c.offsetSec ?? 0) + (c.trimStart ?? 0), 6);
    });
  }

  it("a clip shorter than its source does not draw the source it never plays", () => {
    // The defect, stated as a number: 4 s of a 10 s file, drawn as 10 s.
    const drawn = audioClipWaveformWindow(SOURCE_SEC, 0, 0, 0, 4);
    expect(drawn.endSec - drawn.startSec).toBeCloseTo(4, 6);
  });

  it("the arrangement panel passes the cap at every waveform call site", () => {
    const panel = readFileSync(resolve(process.cwd(), "src/ui/ArrangementPanel.tsx"), "utf8");
    expect(panel).toContain("audioClipWaveformWindow(buffer.duration, offsetSec, trimStart, trimEnd, playedSourceSec)");
    // Both clip bodies (arrangement + take lanes) and the comp measurement.
    expect((panel.match(/playedSourceSec=\{audioClipPlayedSourceSec\(/g) ?? []).length).toBe(2);
    expect(panel).toMatch(/audioClipPlayedSourceSec\(\s*clip,\s*buffer\.duration/);
  });
});
