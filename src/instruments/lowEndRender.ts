/**
 * LOW-END STACK wave 3 — the render bridge. Hands the pure analyzer
 * (lowEndMeasure.ts) real PCM: THREE offline renders of the stems — the mix
 * (kick+bass, real effects: KOREŇ and the sidechain RUN), the kick solo and
 * the bass solo. buildStemProject keeps the track effects; the master chain
 * is bypassed (a master limiter would flatten the very pump being
 * measured). Same options, same deterministic context, tick-0 start — the
 * three buffers are sample-aligned, which is what the superposition
 * residual in the analyzer rides on.
 *
 * Report-only by contract: nothing here touches the project model, and any
 * environment without OfflineAudioContext fails with a named error the
 * caller surfaces honestly (the model-level fit verdict still stands).
 */

import { buildStemProject } from "../rendering/stems";
import { PPQ, midiToFreq, type ProjectDocument } from "../project-model/types";
import { lowEndPlan, type LowEndPlan } from "./lowEnd";
import { kickFundamentalMidi, kickOnsetsOf } from "./lowEndBass";
import { measureLowEndRender, type LowEndBandMeasurement } from "./lowEndMeasure";
import type { SampleBank } from "../sample-library/factory";

/** The bass note the measurement centers the bass band on (lowest pitch). */
function bassFundamentalMidi(doc: ProjectDocument, plan: LowEndPlan): number | null {
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
  const notes = pattern?.notes?.[plan.bassTrackId ?? ""] ?? [];
  if (notes.length === 0) return null;
  return Math.min(...notes.map((note) => note.pitch));
}

/** Mono mixdown of a rendered buffer — the low end is mono material by nature. */
function monoMixdown(buffer: AudioBuffer): Float32Array {
  const pcm = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < pcm.length; i++) pcm[i]! += (data[i] ?? 0) / buffer.numberOfChannels;
  }
  return pcm;
}

export async function renderLowEndBands(
  doc: ProjectDocument,
  bank: SampleBank,
  planInput?: LowEndPlan,
): Promise<LowEndBandMeasurement> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error(
      "OfflineAudioContext is not available in this environment — the render measurement is unsupported here.",
    );
  }
  const plan = planInput ?? lowEndPlan(doc);
  if (!plan.kickTrackId || !plan.bassTrackId) {
    throw new Error("Build the low-end stack first — the measurement needs both tracks.");
  }
  const bassMidi = bassFundamentalMidi(doc, plan);
  if (bassMidi === null) {
    throw new Error("The bass is silent in this pattern — seed a line or write notes first.");
  }
  const { skeleton } = kickOnsetsOf(doc, plan.kickTrackId);
  if (skeleton) {
    throw new Error("The kick is silent in this pattern — the pump needs real kick notes to measure.");
  }

  const keep = (track: { id: string }) => track.id === plan.kickTrackId || track.id === plan.bassTrackId;
  const mixDoc = buildStemProject(doc, keep);
  const kickDoc = buildStemProject(doc, (track) => track.id === plan.kickTrackId);
  const bassDoc = buildStemProject(doc, (track) => track.id === plan.bassTrackId);

  const secondsPerTick = 60 / (doc.bpm * PPQ);
  const { onsets } = kickOnsetsOf(doc, plan.kickTrackId);
  const onsetSeconds = onsets.map((ticks) => ticks * secondsPerTick);

  const { renderProject } = await import("../rendering/renderer");
  const options = {
    mode: "pattern" as const,
    sampleRate: 44100,
    tailSeconds: 0.3,
    masterProcessing: false,
  };
  const [mix, kick, bass] = await Promise.all([
    renderProject(mixDoc, bank, options),
    renderProject(kickDoc, bank, options),
    renderProject(bassDoc, bank, options),
  ]);

  return measureLowEndRender(
    { mix: monoMixdown(mix), kick: monoMixdown(kick), bass: monoMixdown(bass) },
    mix.sampleRate,
    { onsetSeconds, analyzedSeconds: mix.length / mix.sampleRate },
    midiToFreq(kickFundamentalMidi(doc, plan)),
    midiToFreq(bassMidi),
  );
}
