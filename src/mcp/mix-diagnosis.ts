import type { Services } from "../services";
import type { ProjectDocument } from "../project-model/types";
import { buildStemProject } from "../rendering/stems";
import { SONG_LOUDNESS_TARGET_LUFS } from "../intent/genre-reference.generated";
import {
  analyzeMixHealth,
  deriveMixAutoFix,
  type MixAutoFix,
  type MixHealthFlag,
  type MixHealthReport,
} from "../analysis/mixDoctor";

/**
 * KYX MCP — MIX DIAGNOSIS BRIDGE (kyx_diagnose_mix, the agent's ears v2).
 *
 * kyx_render_summary gives an agent NUMBERS (LUFS/peak/crest per strip).
 * Numbers still need interpretation; this bridge does the interpretation
 * step with the same rules a human engineer applies, deterministically:
 * it runs the mix-doctor health analysis on the MASTER render (band shares,
 * clipping, crest collapse, stereo correlation, BS.1770 loudness), runs the
 * band character on every PER-STRIP render, attributes problems to the
 * strips that cause them (energy-weighted low-end / HF ownership), and maps
 * every finding to a fix the agent can ACTUALLY CALL — kyx_tracks setGain,
 * kyx_fx more/less, kyx_loudness match, kyx_plugin_param. The output closes
 * the loop: diagnose → fix → re-run → compare.
 *
 * Same honesty contract as render-summary: offline renders through the ONE
 * engine (ADR 0009), per-strip numbers with masterProcessing bypassed,
 * N+1 renders bounded by the strip cap. Pure read — never mutates.
 */

export interface DiagnosedStrip {
  id: string;
  name: string;
  kind: string;
  lufs: number | null;
  peakDb: number;
  crestDb: number;
  /** sub+low energy share 0..1 of THIS strip alone (its own character). */
  lowEndShare: number;
  /** high+air energy share 0..1 — the harshness-prone end. */
  hfShare: number;
  /** LU delta vs the loudest strip (negative = quieter). */
  deltaVsLoudest: number | null;
}

export interface SuggestedAction {
  /** The registered MCP tool that performs the fix. */
  tool: string;
  /** Ready-to-send arguments (JSON-serializable). */
  args: Record<string, unknown>;
  /** One-line evidence link: why this action addresses the finding. */
  why: string;
}

export interface DiagnosisFinding {
  severity: "red" | "yellow";
  check: string;
  detail: string;
  stripId?: string;
  stripName?: string;
  suggest?: SuggestedAction;
}

export interface MixDiagnosisData {
  scope: "master" | "all";
  referenceLufs: number;
  master: {
    lufs: number | null;
    peakDb: number;
    crestDb: number;
    lowEndShare: number;
    hfShare: number;
    stereoCorrelation: number | null;
    clippedSamples: number;
    headroomDb: number;
    /** master LUFS − reference; the streaming-target gap. */
    lufsVsTarget: number | null;
    flags: MixHealthFlag[];
    autoFix: MixAutoFix | null;
  } | null;
  strips: DiagnosedStrip[];
  findings: DiagnosisFinding[];
  /** Ranked evidence lines: who owns the low end / the top end. */
  attributions: string[];
  /** Deduplicated, order-stable fix lines the agent can send as tool calls. */
  suggestedActions: string[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Linear power proxy from LUFS (absolute log scale → energy ratio). */
function lufsToPower(lufs: number): number {
  return Math.pow(10, lufs / 10);
}

/**
 * Energy-weighted ownership of one end of the spectrum: each measured
 * strip contributes (its loudness as power) × (that band's share of its
 * own energy). Deterministic; strips without a measurable LUFS are skipped
 * honestly (they contribute unknown energy).
 */
function rankBandOwnership(
  strips: DiagnosedStrip[],
  band: "lowEndShare" | "hfShare",
): Array<{ strip: DiagnosedStrip; share: number }> {
  const measured = strips.filter((strip) => strip.lufs !== null);
  const total = measured.reduce((acc, strip) => acc + lufsToPower(strip.lufs ?? -99) * strip[band], 0);
  if (total <= 0) return [];
  return measured
    .map((strip) => ({ strip, share: (lufsToPower(strip.lufs ?? -99) * strip[band]) / total }))
    .sort((a, b) => b.share - a.share);
}

const QUIET_OUTLIER_LU = 6;
const COLLISION_SHARE = 0.5;
const COLLISION_LU = 3;
const CREST_COLLAPSED_DB = 6;

/**
 * Per-strip findings from the diagnosed strips. Deterministic rules a human
 * applies by ear: a strip ≥ QUIET_OUTLIER_LU below the loudest is a balance
 * outlier; a collapsed crest means over-compression/over-saturation ON THAT
 * strip; two hot low-end strips are colliding in the sub (kick vs bass).
 */
export function buildStripFindings(strips: DiagnosedStrip[]): DiagnosisFinding[] {
  const findings: DiagnosisFinding[] = [];
  const measured = strips.filter((strip) => strip.lufs !== null);
  if (measured.length < 2) return findings;
  const loudest = measured.reduce((best, strip) => ((strip.lufs ?? -99) > (best.lufs ?? -99) ? strip : best));

  for (const strip of measured) {
    const delta = (strip.lufs ?? 0) - (loudest.lufs ?? 0);
    if (delta <= -QUIET_OUTLIER_LU) {
      findings.push({
        severity: "yellow",
        check: "quiet-strip",
        stripId: strip.id,
        stripName: strip.name,
        detail: `${strip.name} is ${Math.abs(delta).toFixed(1)} LU below the loudest strip (${loudest.name}) — barely audible in the mix`,
        suggest: {
          tool: "kyx_tracks",
          args: {
            op: "setGain",
            trackId: strip.id,
            gainDb: Math.min(3.5, Math.round(Math.abs(delta) * 0.6 * 10) / 10),
          },
          why: "raising the fader closes part of the measured gap (bounded by the setGain ceiling)",
        },
      });
    }
    if (strip.crestDb < CREST_COLLAPSED_DB) {
      findings.push({
        severity: "yellow",
        check: "crest-collapse-strip",
        stripId: strip.id,
        stripName: strip.name,
        detail: `${strip.name} crest ${strip.crestDb.toFixed(1)} dB — the strip itself is over-compressed/over-saturated`,
        suggest: {
          tool: "kyx_fx",
          args: { effect: "compressor", action: "less", trackId: strip.id },
          why: "turning the strip's compression down restores its punch (crest grows)",
        },
      });
    }
  }

  // Sub collision: two DIFFERENT strips both carrying a hot low end near the
  // loudest level — the classic kick-vs-bass mask. Fix: sidechain pump.
  const hot = measured
    .filter((strip) => strip.lowEndShare > COLLISION_SHARE)
    .filter((strip) => (strip.lufs ?? -99) > (loudest.lufs ?? -99) - COLLISION_LU);
  if (hot.length >= 2) {
    const [a, b] = [hot[0]!, hot[1]!];
    findings.push({
      severity: "yellow",
      check: "low-end-collision",
      stripId: b.id,
      stripName: b.name,
      detail: `${a.name} and ${b.name} both carry >${(COLLISION_SHARE * 100).toFixed(0)}% low-end energy at comparable level — they mask each other in the sub`,
      suggest: {
        tool: "kyx_fx",
        args: { effect: "pump", action: "more", family: "bass" },
        why: "sidechain pump ducks the bass under the kick transient — the standard de-mask move",
      },
    });
  }
  return findings;
}

/** Master findings: the mix-doctor flags + the streaming-target gap. */
export function buildMasterFindings(
  report: MixHealthReport,
  referenceLufs: number,
): { findings: DiagnosisFinding[]; autoFix: MixAutoFix | null } {
  const findings: DiagnosisFinding[] = report.flags.map((flag) => ({
    severity: flag.severity,
    check: flag.check,
    detail: flag.detail,
  }));
  const autoFix = deriveMixAutoFix(report);
  if (autoFix !== null) {
    findings.push({
      severity: "yellow",
      check: "mechanical-fix-available",
      detail: autoFix.label,
      suggest: {
        tool: "kyx_loudness",
        args: { op: "match", targetDb: referenceLufs },
        why: "the loudness loop lands the measured level gap on the master config in one undo",
      },
    });
  }
  const lufsGap =
    report.integratedLufs != null && Math.abs(report.integratedLufs - referenceLufs) > 1
      ? {
          severity: "yellow" as const,
          check: "lufs-off-target",
          detail: `master sits ${Math.abs(report.integratedLufs - referenceLufs).toFixed(1)} LU ${
            report.integratedLufs > referenceLufs ? "above" : "below"
          } the ${referenceLufs} streaming target`,
          suggest: {
            tool: "kyx_loudness" as const,
            args: { op: "match", targetDb: referenceLufs },
            why: "measure→trim→verify lands the master on the target and verifies",
          },
        }
      : null;
  if (lufsGap !== null) findings.push(lufsGap);
  return { findings, autoFix };
}

/** Deterministic agent-facing read-back: diagnosis, ownership, actions. */
export function formatMixDiagnosis(data: MixDiagnosisData): string {
  const lines: string[] = [];
  if (data.master) {
    const lufs = data.master.lufs !== null ? `${data.master.lufs.toFixed(1)} LUFS` : "unmeasurable";
    const gap =
      data.master.lufsVsTarget !== null
        ? `${Math.abs(data.master.lufsVsTarget).toFixed(1)} LU ${data.master.lufsVsTarget > 0 ? "above" : "below"} target`
        : "gap unknown";
    lines.push(
      `MASTER — ${lufs} · peak ${data.master.peakDb.toFixed(1)} dBFS · crest ${data.master.crestDb.toFixed(
        1,
      )} dB · low ${(data.master.lowEndShare * 100).toFixed(0)}% · hf ${(data.master.hfShare * 100).toFixed(
        0,
      )}% · ${gap}`,
    );
  }
  const red = data.findings.filter((finding) => finding.severity === "red");
  const yellow = data.findings.filter((finding) => finding.severity === "yellow");
  lines.push(
    red.length === 0
      ? `findings: none red · ${yellow.length} advisory`
      : `findings: ${red.length} red · ${yellow.length} advisory`,
  );
  for (const finding of [...red, ...yellow]) {
    lines.push(`  ${finding.severity === "red" ? "⚠" : "○"} ${finding.check}: ${finding.detail}`);
  }
  for (const attribution of data.attributions) lines.push(`  ${attribution}`);
  if (data.suggestedActions.length > 0) {
    lines.push("next moves (apply, then re-run kyx_diagnose_mix to verify):");
    for (const action of data.suggestedActions) lines.push(`  ${action}`);
  }
  return lines.join("\n");
}

/** The ordered suggested-action list (dedup by tool+args signature). */
export function buildSuggestedActions(findings: DiagnosisFinding[]): string[] {
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const finding of findings) {
    const suggest = finding.suggest;
    if (!suggest) continue;
    const key = `${suggest.tool}:${JSON.stringify(suggest.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(`${suggest.tool} ${JSON.stringify(suggest.args)} — ${finding.suggest?.why ?? ""}`.trimEnd());
  }
  return actions;
}

const STRIP_CAP = 14;

/** The engine path: offline-render master + per-strip stems, diagnose each. */
export async function mcpDiagnoseMix(
  services: Services,
  request: { scope?: "master" | "all" },
): Promise<MixDiagnosisData> {
  const scope = request.scope ?? "all";
  const doc: ProjectDocument = services.store.getDoc();
  const { renderProject } = await import("../rendering/renderer");
  const mode = doc.arrangement.clips.length > 0 ? "song" : "pattern";
  const sampleRate = 44100 as const;

  // Master: FULL chain (what the listener hears) — its report drives the
  // master findings and the auto-fix.
  const masterBuffer = await renderProject(doc, services.bank, { mode, sampleRate, tailSeconds: 0.6 });
  const masterChannels: Float32Array[] = [];
  for (let channel = 0; channel < masterBuffer.numberOfChannels; channel += 1) {
    masterChannels.push(masterBuffer.getChannelData(channel));
  }
  const masterReport = analyzeMixHealth(masterChannels, masterBuffer.sampleRate);

  const strips: DiagnosedStrip[] = [];
  if (scope !== "master") {
    const candidates = doc.tracks.filter((track) => track.kind !== "group");
    const overflow = candidates.length - STRIP_CAP;
    const bounded = overflow > 0 ? candidates.slice(0, STRIP_CAP) : candidates;
    for (const track of bounded) {
      const stemDoc = buildStemProject(doc, (candidate) => candidate.id === track.id);
      const buffer = await renderProject(stemDoc, services.bank, {
        mode,
        sampleRate,
        tailSeconds: 0.6,
        masterProcessing: false,
      });
      const channels: Float32Array[] = [];
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        channels.push(buffer.getChannelData(channel));
      }
      const report = analyzeMixHealth(channels, buffer.sampleRate);
      strips.push({
        id: track.id,
        name: track.name,
        kind: track.kind,
        lufs: report.integratedLufs,
        peakDb: round2(-20 * Math.log10(Math.max(report.peak, 1e-4))),
        crestDb: round2(report.crestDb),
        lowEndShare: round2(report.lowEndShare),
        hfShare: round2(report.bandShares.high + report.bandShares.air),
        deltaVsLoudest: null,
      });
    }
    const loudestLufs = strips.reduce<number>(
      (best, strip) => (strip.lufs !== null && strip.lufs > best ? strip.lufs : best),
      -Infinity,
    );
    for (const strip of strips) {
      strip.deltaVsLoudest =
        strip.lufs !== null && Number.isFinite(loudestLufs) ? round2(strip.lufs - loudestLufs) : null;
    }
  }

  const { findings: masterFindings, autoFix } = buildMasterFindings(masterReport, SONG_LOUDNESS_TARGET_LUFS);

  const data: MixDiagnosisData = {
    scope,
    referenceLufs: SONG_LOUDNESS_TARGET_LUFS,
    master: {
      lufs: masterReport.integratedLufs,
      peakDb: round2(-20 * Math.log10(Math.max(masterReport.peak, 1e-4))),
      crestDb: round2(masterReport.crestDb),
      lowEndShare: round2(masterReport.lowEndShare),
      hfShare: round2(masterReport.bandShares.high + masterReport.bandShares.air),
      stereoCorrelation: masterReport.stereoCorrelation !== null ? round2(masterReport.stereoCorrelation) : null,
      clippedSamples: masterReport.clippedSamples,
      headroomDb: round2(masterReport.headroomDb),
      lufsVsTarget:
        masterReport.integratedLufs !== null ? round2(masterReport.integratedLufs - SONG_LOUDNESS_TARGET_LUFS) : null,
      flags: masterReport.flags,
      autoFix,
    },
    strips,
    findings: [...masterFindings, ...buildStripFindings(strips)],
    // Band ownership attribution — only meaningful with per-strip scope.
    attributions: scope !== "master" ? formatAttributions(strips) : [],
    suggestedActions: [],
  };

  data.findings = [...data.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  data.suggestedActions = buildSuggestedActions(data.findings);
  return data;
}

function severityRank(severity: "red" | "yellow"): number {
  return severity === "red" ? 0 : 1;
}

/** Deterministic ownership lines (called with strips that carry band shares). */
export function formatAttributions(strips: DiagnosedStrip[]): string[] {
  const lines: string[] = [];
  const low = rankBandOwnership(strips, "lowEndShare");
  if (low.length > 0 && low[0]!.share >= 0.4) {
    lines.push(
      `low-end ownership: ${low[0]!.strip.name} ≈${Math.round(low[0]!.share * 100)}% of low energy${
        low.length > 1 && low[1]!.share >= 0.2
          ? ` · next ${low[1]!.strip.name} ≈${Math.round(low[1]!.share * 100)}%`
          : ""
      }`,
    );
  }
  const hf = rankBandOwnership(strips, "hfShare");
  if (hf.length > 0 && hf[0]!.share >= 0.4) {
    lines.push(`top-end ownership: ${hf[0]!.strip.name} ≈${Math.round(hf[0]!.share * 100)}% of high energy`);
  }
  return lines;
}
