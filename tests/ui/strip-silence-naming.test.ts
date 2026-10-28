import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE "STRIP SILENCE" NAMING GATE (P-4a, audit HCP-05-07 / HCP-03-13 family).
 *
 * The button used to read "Strip Silence (PT)". The acronym had no legend
 * anywhere in the repository — it arrived with the feature drop 26462b0b
 * (2026-08-29) and appeared in no other string, in no doc and in no test.
 *
 * The author answered on 2026-10-28 what it meant: **PITCH AND TEMPO
 * PRESERVED**. The suffix is gone and the tooltip now says so in words, in
 * the author's own vocabulary.
 *
 * This spec holds that decision because the failure mode is SILENT. A
 * well-meaning copy edit that puts "(PT)" back, or that swaps the author's
 * "tempo" for a near synonym, would look like an improvement and would
 * change nothing for the user. The decision has no behavioural trace to
 * assert on — it IS a string.
 *
 * It is a SOURCE gate on purpose: the button lives inside the audio-clip
 * context menu, and opening that menu in a DOM test would cost far more
 * than it would prove. The wording is a string in the source; the string is
 * what the gate checks.
 *
 * Verified against the implementation before the wording was fixed: the
 * fragments of a stripped clip inherit the parent clip (`...clip`), keep the
 * parent's playback rate (`audioClipSourceSecondsPerWallSecond`) and read the
 * same source span (`offsetSec: seg.start`, `trimStart/trimEnd: 0`) — so the
 * pitch is preserved AND the clip's tempo is preserved, and nothing is
 * re-tuned. The tooltip says exactly that.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arrangementSource = readFileSync(join(root, "src/ui/ArrangementPanel.tsx"), "utf8");

/** Every source file under `src/`, so a stray acronym anywhere is caught. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** The button's `title` attribute — the sentence that replaced the acronym. */
function stripSilenceTooltip(): string {
  const labelAt = arrangementSource.indexOf("Strip Silence");
  expect(labelAt, "the Strip Silence button is gone from the arrangement panel").toBeGreaterThan(-1);
  // The title attribute sits on the button, a few lines above its label.
  const window = arrangementSource.slice(Math.max(0, labelAt - 1200), labelAt);
  const match = /title="([^"]*)"/.exec(window);
  expect(match, "the Strip Silence button has no title to read").not.toBeNull();
  return match![1];
}

describe("the Strip Silence naming gate (P-4a)", () => {
  it("the button label is the plain name — no acronym suffix", () => {
    const labels = arrangementSource
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Strip Silence"));
    expect(labels, "expected exactly one Strip Silence label").toHaveLength(1);
    expect(labels[0]).toBe("Strip Silence");
  });

  it("no source file still carries the '(PT)' acronym", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, "src"))) {
      if (readFileSync(file, "utf8").includes("(PT)")) offenders.push(file.replace(root, "."));
    }
    expect(offenders, `the '(PT)' acronym is back in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the tooltip names pitch AND tempo — the author's own words", () => {
    const tooltip = stripSilenceTooltip();
    expect(tooltip, "the tooltip must state that the pitch is preserved").toMatch(/pitch/i);
    expect(tooltip, "the tooltip must state that the tempo is preserved").toMatch(/tempo/i);
    // The near synonym the author did NOT use: "speed" describes the playback
    // rate, not the musical tempo, and the two are not the same claim.
    expect(tooltip, "the tooltip must not swap the author's 'tempo' for 'speed'").not.toMatch(/\bspeed\b/i);
  });

  it("the tooltip says the clip is not re-tuned", () => {
    // The one clarification that keeps "tempo" from being misread as "the
    // project BPM": the operation rewrites the clip, it does not retune it.
    expect(stripSilenceTooltip()).toMatch(/not re-tuned/i);
  });
});
