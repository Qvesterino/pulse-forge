/**
 * PARAM VERIFICATION (P3 of the param wave, plan 2026-10-14) — the measured
 * readback: after a param ask lands, render the target track BEFORE and
 * AFTER, measure the feature the ROLE claims to move, and answer with a
 * number ("lead jasnejší o +12 % ✓") — or an honest correction chip when
 * the measurement shows no move.
 *
 * Role → measurable feature (pure math, no models):
 *   tone  → spectral centroid (brighter = up) — SATURATION only; the
 *           reverb/delay output lowpass acts on the wet path, where the
 *           full-render centroid's direction is source-dependent (verifier
 *           2026-10-15: 1200→16000 Hz measured −1.8 %) → honestly unmeasured
 *   cutoff → spectral centroid (a lowpass filter's full-wet output)
 *   width → mid/side stereo width
 *   mix   → RMS level
 *   threshold → crest factor (peak / RMS): falls as the compressor squashes
 *   drive/time/attack/release/Q → NOT measured in v1 (null; the knob readback
 *   in param-intent.ts still reports the value move). Attack/release/Q need a
 *   transient fixture and an ear; claiming a direction from a static render
 *   would be a false pass.
 *
 * Audition-first: a correction is a SUGGESTION string for the panel chip —
 * nothing re-applies silently.
 *
 * Known v1 boundary (caught by the real-audio verifier 2026-10-15): when the
 * intent ADDS the effect (add-if-missing), the BEFORE render has no effect at
 * all, so the delta conflates "effect appeared" with "knob moved" — a fresh
 * reverb's tail darkens the centroid whatever the tone knob does. Knob-move
 * asks on an installed effect (the common case) measure cleanly; an add+set
 * reports the overall delta honestly without a correction chip.
 */
import type { ProjectDocument } from "../project-model/types";
import { extractAudioFeaturesV2, extractStereoAudioFeatures } from "../ai/audio-features";
import { defaultParamsOf } from "../effects/definitions";
import type { ParamRole, ParamIntent } from "./param-intent";
import { trackIdsForMixTarget } from "./param-intent";
import { capabilityFor, type MetricId } from "./semantics/param-registry";

/** Render one track of one doc; null = render failed (skip that target). */
export type RenderTrackFn = (doc: ProjectDocument, trackId: string) => Promise<AudioBuffer | null>;

export interface ParamVerificationTarget {
  target: string;
  trackId: string;
  /** Human metric name ("jas", "šírka", "hlasitosť"). */
  metric: string;
  before: number;
  after: number;
  /** Relative change in percent (after-before)/before — 0 when before ~ 0. */
  deltaPct: number;
  passed: boolean;
  matchesAsk: boolean;
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

function metricOf(metric: MetricId, buffer: AudioBuffer): Metric | null {
  if (metric === "centroid") {
    const mono = monoOf(buffer);
    if (!mono) return null;
    return { name: "jas", value: extractAudioFeaturesV2(mono, buffer.sampleRate).spectralCentroid };
  }
  if (metric === "width") {
    if (buffer.numberOfChannels < 2) return null;
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    return { name: "šírka", value: extractStereoAudioFeatures(left, right).width };
  }
  if (metric === "rms") {
    const mono = monoOf(buffer);
    if (!mono) return null;
    return { name: "hlasitosť", value: extractAudioFeaturesV2(mono, buffer.sampleRate).rms };
  }
  if (metric === "crest") {
    // Crest factor (peak / RMS) falls as the threshold drops and the compressor
    // squashes the transient. This is the audibility proxy for "more squish".
    const mono = monoOf(buffer);
    if (!mono) return null;
    return { name: "dynamika", value: extractAudioFeaturesV2(mono, buffer.sampleRate).crestFactor };
  }
  return null; // no metric: honestly unmeasured
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
 * For SET asks: did the knob move UP on this target's resolved track?
 * Reads the same instance path the knob readback uses; a missing instance
 * falls back to the effect default. Equal values count as up (the ask made
 * no downward move).
 */
function setAskMovesUp(before: ProjectDocument, after: ProjectDocument, intent: ParamIntent, trackId: string): boolean {
  const read = (doc: ProjectDocument): number | undefined => {
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (!track || !("effects" in track)) return undefined;
    const instance = track.effects.find((effect) => effect.type === intent.effectType);
    return instance?.params[intent.paramId];
  };
  const beforeValue = read(before) ?? defaultParamsOf(intent.effectType)[intent.paramId] ?? 0;
  const afterValue = read(after);
  if (afterValue === undefined) return true;
  return afterValue >= beforeValue;
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
  // Wet-path tone (reverb/delay output lowpass) is honestly unmeasured v1:
  // the real-audio verifier showed the full-render centroid moves the WRONG
  // way when the LP opens (1200→16000 Hz landed at −1.8 %) — opening the
  // tail adds mid-heavy energy, so the mix centroid drifts toward the tail
  // whatever the knob does. The direction is source-dependent; claiming it
  // would print false corrections. Saturation's tone tilt acts on the dry
  // path and keeps the centroid trustworthy.
  const wetPathTone = intent.role === "tone" && (intent.effectType === "reverb" || intent.effectType === "delay");
  // The registry owns which feature a family claims to move. A null metric is
  // an honest "not measured", not a failed render.
  const metric = capabilityFor(intent.role, intent.effectType)?.metric ?? null;
  const targets: ParamVerificationTarget[] = [];
  const trackTargets = new Map<string, string>();
  if (!wetPathTone) {
    for (const target of intent.targets) {
      for (const trackId of trackIdsForMixTarget(before, target)) {
        const track = before.tracks.find((candidate) => candidate.id === trackId);
        trackTargets.set(trackId, track?.name ?? target);
      }
    }
    for (const trackId of intent.trackIds ?? []) {
      const track = before.tracks.find((candidate) => candidate.id === trackId);
      if (track) trackTargets.set(trackId, track.name);
    }
    if (intent.trackOrdinal != null) {
      const track = before.tracks.filter((candidate) => candidate.kind !== "group")[intent.trackOrdinal];
      if (track) trackTargets.set(track.id, track.name);
    }
  }
  for (const [trackId, target] of trackTargets) {
    let beforeBuffer: AudioBuffer | null = null;
    let afterBuffer: AudioBuffer | null = null;
    try {
      beforeBuffer = await render(before, trackId);
      afterBuffer = await render(after, trackId);
    } catch {
      continue;
    }
    if (!beforeBuffer || !afterBuffer) continue;
    const beforeMetric = metricOf(metric, beforeBuffer);
    const afterMetric = metricOf(metric, afterBuffer);
    if (!beforeMetric || !afterMetric || beforeMetric.name !== afterMetric.name) continue;
    const deltaPct =
      beforeMetric.value > 1e-9
        ? ((afterMetric.value - beforeMetric.value) / beforeMetric.value) * 100
        : afterMetric.value > 1e-9
          ? 100
          : 0;
    const askedUp =
      intent.mode === "less" ? false : intent.mode === "more" ? true : setAskMovesUp(before, after, intent, trackId);
    const passed = Math.abs(deltaPct) >= DELTA_THRESHOLD_PCT;
    targets.push({
      target,
      trackId,
      metric: beforeMetric.name,
      before: beforeMetric.value,
      after: afterMetric.value,
      deltaPct: Math.round(deltaPct * 10) / 10,
      passed,
      matchesAsk: passed && (askedUp ? deltaPct > 0 : deltaPct < 0),
    });
  }

  const measurable = targets.length > 0;
  const completeCoverage = targets.length === trackTargets.size;
  const verified = measurable && completeCoverage && targets.every((entry) => entry.matchesAsk);
  const correction =
    measurable && !verified && intent.mode !== "set"
      ? completeCoverage
        ? "meranie neukazuje počuteľnú zmenu na všetkých cieľoch — skúsiť ×1,5 alebo väčší stupeň?"
        : `meranie pokrylo iba ${targets.length} z ${trackTargets.size} cieľov — skontroluj nevyrenderované stopy`
      : null;

  let line: string;
  if (!measurable) {
    const unmeasured = metric === null;
    line = wetPathTone
      ? "tón na wet-ceste (reverb/delay) ešte nemeráme spoľahlivo — gombík sa ale pohol"
      : unmeasured
        ? "meranie tejto role ešte nemáme (drive/time/attack/release/Q v1) — gombík sa pohol"
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
            : entry.metric === "dynamika"
              ? entry.deltaPct > 0
                ? "dynamickejší"
                : "stlačenejší"
              : entry.deltaPct > 0
                ? "hlasnejší"
                : "tichší";
      return `${entry.target} (trackId=${entry.trackId}) ${what} o ${Math.abs(entry.deltaPct).toFixed(0)} % (${direction} ${entry.metric})`;
    });
    line = `✓ ${parts.join(" · ")}`;
  } else {
    line = `⚠ ${targets.map((entry) => `${entry.target} (trackId=${entry.trackId}): ${entry.metric} ${entry.deltaPct >= 0 ? "+" : ""}${entry.deltaPct.toFixed(1)} %`).join(" · ")}${completeCoverage ? "" : ` · measured ${targets.length}/${trackTargets.size} tracks`}`;
  }

  return { role: intent.role, measurable, targets, verified, line, correction };
}
