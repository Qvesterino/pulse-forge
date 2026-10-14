/**
 * PARAM VERIFICATION (P3 of the param wave, plan 2026-10-14) — the measured
 * readback: after a param ask lands, render the target track BEFORE and
 * AFTER, measure the feature the ROLE claims to move, and answer with a
 * number ("lead jasnejší o +12 % ✓") — or an honest correction chip when
 * the measurement shows no move.
 *
 * Role → measurable feature (pure math, no models):
 *   tone  → spectral centroid (brighter = up)
 *   width → mid/side stereo width
 *   mix   → RMS level
 *   drive/time → NOT measured in v1 (measured honestly as null — the param
 *   readback in param-intent.ts still reports the knob value move).
 *
 * Audition-first: a correction is a SUGGESTION string for the panel chip —
 * nothing re-applies silently.
 */
import type { ProjectDocument } from "../project-model/types";
import { extractAudioFeaturesV2, extractStereoAudioFeatures } from "../ai/audio-features";
import type { ParamRole, ParamIntent } from "./param-intent";
import { trackIdsForMixTarget } from "./param-intent";

/** Render one track of one doc; null = render failed (skip that target). */
export type RenderTrackFn = (doc: ProjectDocument, trackId: string) => Promise<AudioBuffer | null>;

export interface ParamVerificationTarget {
  target: string;
  /** Human metric name ("jas", "šírka", "hlasitosť"). */
  metric: string;
  before: number;
  after: number;
  /** Relative change in percent (after-before)/before — 0 when before ~ 0. */
  deltaPct: number;
  passed: boolean;
}

export interface ParamVerification {
  role: ParamRole;
  /** False when the role has no v1 measurement (drive/time) or no target rendered. */
  measurable: boolean;
  targets: ParamVerificationTarget[];
  /** Any target moved beyond the audibility threshold in the ASKED direction. */
  verified: boolean;
  /** Ready-made status line, SK. */
  line: string;
  /** Correction suggestion when the ask was relative and nothing moved. */
  correction: string | null;
}

/** 3 % relative change — below this a "more/less" ask did not land audibly. */
const DELTA_THRESHOLD_PCT = 3;

interface Metric {
  name: string;
  value: number;
}

function metricOf(role: ParamRole, buffer: AudioBuffer): Metric | null {
  if (role === "tone") {
    const mono = monoOf(buffer);
    if (!mono) return null;
    return { name: "jas", value: extractAudioFeaturesV2(mono, buffer.sampleRate).spectralCentroid };
  }
  if (role === "width") {
    if (buffer.numberOfChannels < 2) return null;
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    return { name: "šírka", value: extractStereoAudioFeatures(left, right).width };
  }
  if (role === "mix") {
    const mono = monoOf(buffer);
    if (!mono) return null;
    return { name: "hlasitosť", value: extractAudioFeaturesV2(mono, buffer.sampleRate).rms };
  }
  return null; // drive/time: not measured in v1
}

function monoOf(buffer: AudioBuffer): Float32Array | null {
  if (buffer.length === 0) return null;
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < mono.length; index += 1)
      mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / buffer.numberOfChannels;
  }
  return mono;
}

/**
 * Measure a param ask's landing. Renders each target track on the BEFORE and
 * AFTER docs through the injected renderer (the panel passes renderTrack
 * with the live bank; tests pass synthetic buffers). NEVER throws — a failed
 * render degrades to an unmeasured target.
 */
export async function measureParamVerification(
  before: ProjectDocument,
  after: ProjectDocument,
  intent: ParamIntent,
  render: RenderTrackFn,
): Promise<ParamVerification> {
  const targets: ParamVerificationTarget[] = [];
  for (const target of intent.targets) {
    const ids = trackIdsForMixTarget(before, target);
    if (ids.length === 0) continue;
    const trackId = ids[0] as string;
    let beforeBuffer: AudioBuffer | null = null;
    let afterBuffer: AudioBuffer | null = null;
    try {
      beforeBuffer = await render(before, trackId);
      afterBuffer = await render(after, trackId);
    } catch {
      continue;
    }
    if (!beforeBuffer || !afterBuffer) continue;
    const beforeMetric = metricOf(intent.role, beforeBuffer);
    const afterMetric = metricOf(intent.role, afterBuffer);
    if (!beforeMetric || !afterMetric || beforeMetric.name !== afterMetric.name) continue;
    const deltaPct =
      beforeMetric.value > 1e-9
        ? ((afterMetric.value - beforeMetric.value) / beforeMetric.value) * 100
        : afterMetric.value > 1e-9
          ? 100
          : 0;
    targets.push({
      target,
      metric: beforeMetric.name,
      before: beforeMetric.value,
      after: afterMetric.value,
      deltaPct: Math.round(deltaPct * 10) / 10,
      passed: Math.abs(deltaPct) >= DELTA_THRESHOLD_PCT,
    });
  }

  const measurable = targets.length > 0;
  const askedUp = intent.mode !== "less";
  const verified =
    measurable && targets.some((entry) => entry.passed && (askedUp ? entry.deltaPct > 0 : entry.deltaPct < 0));
  const correction =
    measurable && !verified && intent.mode !== "set"
      ? "meranie neukazuje počuteľnú zmenu — skúsiť ×1,5 alebo väčší stupeň?"
      : null;

  let line: string;
  if (!measurable) {
    line =
      intent.role === "drive" || intent.role === "time"
        ? "meranie tejto role ešte nemáme (drive/time v1)"
        : "meranie zlyhalo — renderer nedodal audio";
  } else if (verified) {
    const moved = targets.filter((entry) => entry.passed);
    const parts = moved.map((entry) => {
      const direction = entry.deltaPct > 0 ? "viac" : "menej";
      const what =
        entry.metric === "jas"
          ? entry.deltaPct > 0
            ? "jasnejší"
            : "tmavší"
          : entry.metric === "šírka"
            ? entry.deltaPct > 0
              ? "širší"
              : "užší"
            : entry.deltaPct > 0
              ? "hlasnejší"
              : "tichší";
      return `${entry.target} ${what} o ${Math.abs(entry.deltaPct).toFixed(0)} % (${direction} ${entry.metric})`;
    });
    line = `✓ ${parts.join(" · ")}`;
  } else {
    line = `⚠ ${targets.map((entry) => `${entry.target}: ${entry.metric} ${entry.deltaPct >= 0 ? "+" : ""}${entry.deltaPct.toFixed(1)} %`).join(" · ")}`;
  }

  return { role: intent.role, measurable, targets, verified, line, correction };
}
