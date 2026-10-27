import type { Services } from "../services";
import { separateHPSS } from "../analysis/hpss";
import { separateTrackModel } from "../analysis/stem-model/client";
import { probeStemModelManifest, manifestGatePassed } from "../analysis/stem-model/gate";
import { stemModelFlagOn } from "../analysis/stem-model/gate";
import { loadUserSampleMono } from "./sample-mono";
import type { StemRole } from "./stem-mastering";

/**
 * kyx_separate — the separation step of the agent loop. Turns a
 * user-library audio asset into stem BUFFERS the agent can hand straight
 * to `kyx_master op:"stems" import:[…]` (which builds the STEMS bus and
 * shapes every lane). This is the one piece the surface lacked: an agent
 * could import stems and master them, but only a HUMAN could produce them.
 *
 * Two tiers, honestly scoped:
 *  - "hpss" (default) — the deterministic harmonic/percussive split, the
 *    shipping tier (ADR 0019/S5). Three lanes: drums, bass, other.
 *  - "model" — the gated htdemucs tier, four lanes. Refused unless the
 *    OWNER already turned `pf:stem-model` on and the manifest gate passed:
 *    an agent call never downloads an 80 MB model on its own (the recorded
 *    kyx_unsuno concern, kept here).
 *
 * Buffers land in the live SampleBank under `stem.<sourceId>.<role>` ids —
 * the same ids `addAudioClip` resolves. Report-only on the document: the
 * tool returns bufferIds; the IMPORT (a mutation) stays the caller's
 * explicit next step.
 */

export type SeparationTier = "hpss" | "model";

export interface SeparatedStem {
  role: StemRole;
  bufferId: string;
  durationSec: number;
  peakDb: number;
}

export interface SeparateStemsResult {
  tier: SeparationTier;
  sourceId: string;
  stems: SeparatedStem[];
  sourceSeconds: number;
  notes: string[];
}

export type SeparateStemsOutcome = { ok: true; result: SeparateStemsResult } | { ok: false; error: string };

const peakDbOf = (pcm: Float32Array): number => {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  return 20 * Math.log10(Math.max(peak, 1e-6));
};

function stemBuffer(
  bank: Pick<Services["bank"], "add">,
  bufferId: string,
  pcm: Float32Array,
  sampleRate: number,
): { durationSec: number; peakDb: number } {
  const buffer = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate });
  // A private copy: the bank owns its buffers, and copyToChannel wants a
  // strictly ArrayBuffer-backed view anyway.
  buffer.copyToChannel(new Float32Array(pcm), 0);
  bank.add(bufferId, buffer);
  return { durationSec: pcm.length / sampleRate, peakDb: peakDbOf(pcm) };
}

export async function separateStemsForAgent(
  services: Pick<Services, "bank" | "userSamples">,
  sourceId: string,
  options: { tier?: SeparationTier; maxSeconds?: number } = {},
): Promise<SeparateStemsOutcome> {
  const id = sourceId.trim();
  if (!id) return { ok: false, error: "kyx_separate needs sourceId — a user-library audio id." };
  const tier = options.tier === "model" ? "model" : "hpss";

  const loaded = await loadUserSampleMono(services, id);
  if (!loaded) return { ok: false, error: `sample "${id}" not found or undecodable — nothing separated.` };
  const { mono, sampleRate } = loaded;

  const notes: string[] = [];
  const stems: SeparatedStem[] = [];
  const prefix = `stem.${id}`;

  if (tier === "model") {
    // Two distinct refusals: the FLAG is the owner's standing consent (an
    // agent never flips it), the manifest is the download+gate state. An
    // agent needs to know which one to ask the owner for.
    if (!stemModelFlagOn()) {
      return {
        ok: false,
        error:
          'the model tier is owner-gated: pf:stem-model is OFF — ask the owner to turn it on (the separation panel), or run tier:"hpss" now (deterministic, no download).',
      };
    }
    const manifest = await probeStemModelManifest();
    if (!manifest || !manifestGatePassed(manifest)) {
      return {
        ok: false,
        error:
          'pf:stem-model is on but the model is not downloaded/gated yet — the owner completes the download in the separation panel first, or run tier:"hpss" now.',
      };
    }
    const separated = await separateTrackModel(mono, sampleRate, { maxSeconds: options.maxSeconds });
    if (!separated || separated.stems.length !== separated.stemNames.length) {
      notes.push(
        "the model returned no usable stems — falling back is NOT automatic; retry hpss if you need a split now.",
      );
      return { ok: false, error: "the gated model produced no stems (session or execution-provider failure)." };
    }
    separated.stemNames.forEach((role, index) => {
      const pcm = separated.stems[index]!;
      stems.push({
        role,
        bufferId: `${prefix}.${role}`,
        ...stemBuffer(services.bank, `${prefix}.${role}`, pcm, sampleRate),
      });
    });
    notes.push(`model ${separated.modelVersion} on ${separated.ep} — owner-gated tier.`);
  } else {
    const separated = separateHPSS(mono, sampleRate, { maxSeconds: options.maxSeconds });
    if (!separated) {
      return { ok: false, error: "the source is too short or too quiet to separate (needs ≥ 1 s of signal)." };
    }
    const lanes: Array<[StemRole, Float32Array]> = [
      ["drums", separated.percussive],
      ["bass", separated.bass],
      ["other", separated.harmonic],
    ];
    for (const [role, pcm] of lanes) {
      stems.push({
        role,
        bufferId: `${prefix}.${role}`,
        ...stemBuffer(services.bank, `${prefix}.${role}`, pcm, sampleRate),
      });
    }
    if (separated.analyzedSec < loaded.mono.length / sampleRate - 0.5) {
      notes.push(
        `analysis capped at ${separated.analyzedSec.toFixed(0)} s of ${stemSeconds(loaded.mono, sampleRate)} s source.`,
      );
    }
    notes.push("hpss is the deterministic tier: percussion vs tonal split — vocals stay inside 'other'.");
  }

  return {
    ok: true,
    result: {
      tier,
      sourceId: id,
      stems,
      sourceSeconds: stemSeconds(mono, sampleRate),
      notes,
    },
  };
}

function stemSeconds(mono: Float32Array, sampleRate: number): number {
  return mono.length / sampleRate;
}

/** The read-back line the tool returns — with the exact next-step call. */
export function describeSeparation(result: SeparateStemsResult): string {
  const lanes = result.stems
    .map(
      (stem) => `${stem.role}: ${stem.bufferId} (${stem.durationSec.toFixed(1)} s, peak ${stem.peakDb.toFixed(1)} dB)`,
    )
    .join("\n");
  const importArg = JSON.stringify(
    result.stems.map((stem) => ({
      role: stem.role,
      bufferId: stem.bufferId,
      durationSec: Number(stem.durationSec.toFixed(2)),
    })),
  );
  return (
    `Separated "${result.sourceId}" with tier "${result.tier}" — ${result.stems.length} stem buffers in the bank:\n` +
    `${lanes}\n` +
    `${result.notes.join(" ")}\n` +
    `Next: kyx_master op:"stems" import:${importArg} — builds the STEMS bus and shapes every lane.`
  );
}
