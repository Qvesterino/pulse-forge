import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";
import type { SampleBank } from "../sample-library/factory";
import type { ProjectDocument } from "../project-model/types";
import { setMasterConfig } from "../commands/commands";
import { SONG_LOUDNESS_TARGET_LUFS } from "../intent/genre-reference.generated";

/**
 * D1 LOUDNESS LOOP — "make it louder" / "make it quieter" / "loudness na −9".
 *
 * A real measure-and-adjust loop: renders the project OFFLINE through the
 * full master chain (the same path exports take), measures gated integrated
 * LUFS (BS.1770-4 dual gate via the engine's K-weighting), and moves
 * `master.loudnessTrimDb` toward the target — composes with the song
 * builder's per-genre trim (reads the CURRENT trim, adds the needed delta,
 * clamped to the ±6 dB field). Re-measures after applying (limiter is
 * nonlinear) and converges over at most two corrections.
 *
 * The renderer is INJECTED so unit tests run without an audio context.
 */

export interface LoudnessIntentParse {
  direction: "louder" | "quieter";
  /** Explicit LUFS target ("loudness na −9") — overrides the ±nudge. */
  targetDb?: number;
  detected: string[];
}

export function parseLoudnessIntent(text: string): LoudnessIntentParse | null {
  const lower = ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")} `;
  // Lookbehind (not \b) so a LEADING minus at a word boundary still matches
  // ("−9 lufs" — \b before "-" fails the transition space→hyphen).
  const targetMatch = /\bloudness (?:na |to |target )?(-?\d{1,2})\b|(?<![\d-])(-?\d{1,2})\s*lufs\b/.exec(lower);
  const isLouder = /\bmake it louder\b|\blouder\b|\bmore loud\b|\bhlas(?:it|ie|ej)/.test(lower);
  const isQuieter = /\bmake it quieter\b|\bquieter\b|\bquieter mix\b|\btich(?:ie|si)|\bmenej hlas|\bsofter mix\b/.test(
    lower,
  );
  if (targetMatch) {
    const targetDb = Number(targetMatch[1] ?? targetMatch[2]);
    const detected = [`loudness ${targetDb} LUFS`];
    if (isQuieter) {
      return { direction: "quieter", targetDb, detected };
    }
    return { direction: "louder", targetDb, detected };
  }
  if (isLouder) return { direction: "louder", detected: ["louder"] };
  if (isQuieter) return { direction: "quieter", detected: ["quieter"] };
  return null;
}

const LOUDNESS_TARGET_LUFS = SONG_LOUDNESS_TARGET_LUFS; // −14 (streaming)
const TRIM_MIN = -6;
const TRIM_MAX = 6;
const DEFAULT_NUDGE_DB = 3;
const MAX_ITERATIONS = 2;

export interface LoudnessReport {
  measuredBefore: number;
  measuredAfter: number | null;
  trim: number;
  target: number;
}

export type LoudnessRenderFn = (doc: ProjectDocument, bank: SampleBank) => Promise<AudioBuffer>;

export type LoudnessApplyResult =
  { ok: true; command: ReturnType<typeof setMasterConfig>; report: LoudnessReport } | { ok: false; error: string };

export interface PreviewLoudness {
  /** Trimmed doc — identical to the input when nothing was applied. */
  doc: ProjectDocument;
  /** Resulting `master.loudnessTrimDb` (1-decimal). */
  trim: number;
  /** Gated integrated LUFS of the pre-trim render (null when unmeasurable). */
  measuredBefore: number | null;
  /** LUFS target used (explicit words win, else the SUNO streaming target). */
  target: number;
  /** True when a trim was measured and applied. */
  applied: boolean;
}

/**
 * PREVIEW loudness — single measure → single trim for the song-draft
 * audition. Unlike applyLoudnessIntent (measure → trim → verify loop, up to
 * three renders) this renders ONCE: the draft's own audition render doubles
 * as the verify measurement, so preview == USE at minimum background cost.
 * Never throws — any failure resolves `applied: false` with the input doc,
 * and the draft stays auditionable untrimmed.
 */
export async function applyPreviewLoudness(
  doc: ProjectDocument,
  bank: SampleBank,
  text: string,
  options: { render?: LoudnessRenderFn } = {},
): Promise<PreviewLoudness> {
  const fallback = { direction: "louder" as const, targetDb: LOUDNESS_TARGET_LUFS, detected: [] };
  const parse = parseLoudnessIntent(text) ?? fallback;
  // Direction-only words ("make it louder") carry no number — the SUNO
  // default target still applies; nudges belong to the post-USE loop.
  const target = parse.targetDb ?? LOUDNESS_TARGET_LUFS;
  const currentTrim = doc.master?.loudnessTrimDb ?? 0;
  const render: LoudnessRenderFn =
    options.render ??
    (async (d, b) =>
      (await import("../rendering/renderer")).renderProject(d, b, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 0.4,
      }));
  try {
    const reading = await measureWithRender(doc, bank, render);
    if (!reading.measured) {
      return { doc, trim: currentTrim, measuredBefore: null, target, applied: false };
    }
    const trim = Math.round(neededTrim(currentTrim, reading.integrated, target) * 10) / 10;
    const next = setMasterConfig(doc, { loudnessTrimDb: trim }).execute(doc);
    return { doc: next, trim, measuredBefore: Math.round(reading.integrated * 10) / 10, target, applied: true };
  } catch {
    return { doc, trim: currentTrim, measuredBefore: null, target, applied: false };
  }
}

/** Measure gated integrated LUFS of the whole project (song, or active pattern). */
export async function measureLoudness(
  doc: ProjectDocument,
  bank: SampleBank,
): Promise<{ integrated: number; measured: boolean }> {
  // Dynamic import: the offline renderer carries AudioEngine + worklet
  // loaders — it must not sit in the landing route's static payload.
  const { renderProject } = await import("../rendering/renderer");
  const buffer = await renderProject(doc, bank, { mode: "song", sampleRate: 44100, tailSeconds: 0.4 });
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel));
  }
  const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
  return { integrated: reading.integrated, measured: reading.measured };
}

function neededTrim(currentTrim: number, measured: number, target: number): number {
  return Math.max(TRIM_MIN, Math.min(TRIM_MAX, currentTrim + (target - measured)));
}

/**
 * Measure → adjust `master.loudnessTrimDb` → verify. Without an explicit
 * target the intent nudges the trim ±3 dB (louder/quieter); with a target
 * ("loudness na −9") it converges onto that LUFS. The render function is
 * injectable for tests.
 */

async function measureWithRender(
  doc: ProjectDocument,
  bank: SampleBank,
  render: LoudnessRenderFn,
): Promise<{ integrated: number; measured: boolean }> {
  const buffer = await render(doc, bank);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel));
  }
  const reading = analyzeLoudnessBuffer(channels, buffer.sampleRate);
  return { integrated: reading.integrated, measured: reading.measured };
}

export async function applyLoudnessIntent(
  doc: ProjectDocument,
  bank: SampleBank,
  parse: LoudnessIntentParse,
  options: { render?: LoudnessRenderFn } = {},
): Promise<LoudnessApplyResult> {
  const render: LoudnessRenderFn =
    options.render ??
    (async (d, b) =>
      (await import("../rendering/renderer")).renderProject(d, b, {
        mode: "song",
        sampleRate: 44100,
        tailSeconds: 0.4,
      }));

  let measured: number;
  try {
    const reading = await measureWithRender(doc, bank, render);
    if (!reading.measured)
      return { ok: false, error: "could not measure loudness — the render was too quiet or empty" };
    measured = reading.integrated;
  } catch (error) {
    return { ok: false, error: `loudness render failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const currentTrim = doc.master?.loudnessTrimDb ?? 0;
  const target =
    parse.targetDb !== undefined
      ? parse.targetDb
      : Math.max(
          LOUDNESS_TARGET_LUFS - 6,
          Math.min(
            LOUDNESS_TARGET_LUFS + 6,
            measured + (parse.direction === "louder" ? DEFAULT_NUDGE_DB : -DEFAULT_NUDGE_DB),
          ),
        );

  let trim = neededTrim(currentTrim, measured, target);
  let command = setMasterConfig(doc, { loudnessTrimDb: Math.round(trim * 10) / 10 });
  let report: LoudnessReport = {
    measuredBefore: Math.round(measured * 10) / 10,
    measuredAfter: null,
    trim: Math.round(trim * 10) / 10,
    target,
  };

  // Verify loop: re-render with the applied trim and correct once more — the
  // limiter makes the chain nonlinear, so the first step can undershoot.
  let cursor = command.execute(doc);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let after: number;
    try {
      const reading = await measureWithRender(cursor, bank, render);
      if (!reading.measured) break;
      after = reading.integrated;
    } catch {
      break;
    }
    report.measuredAfter = Math.round(after * 10) / 10;
    const remaining = target - after;
    if (Math.abs(remaining) <= 1) break;
    const nextTrim = neededTrim(trim, after, target);
    if (Math.abs(nextTrim - trim) < 0.1) break;
    trim = nextTrim;
    command = setMasterConfig(doc, { loudnessTrimDb: Math.round(trim * 10) / 10 });
    cursor = command.execute(doc);
  }
  report.trim = Math.round(trim * 10) / 10;
  return { ok: true, command, report };
}
