import { analyzeLoudnessBuffer } from "../audio-engine/kweighting";

/**
 * MIX DOCTOR (library-gate wave follow-up, 2026-09-30) — automatic mix QA on
 * every master export. The sound-library audit proved the failure modes that
 * actually ruin generated beats are measurable: the pre-fix trap mix summed
 * to +7.8 dB over full scale with 86 % of its energy below 120 Hz and a
 * 4.2 dB crest — clipping, low-end dominance and over-compression in one
 * render. This module measures exactly those dimensions on a rendered buffer
 * and reports flags.
 *
 * PURE by contract (AGENTS invariant #4): a deterministic function of the
 * input channels — no state, no time, never adjusts anything. Auto-correction
 * (gain staging within the existing one-undo song command) is a deliberate
 * follow-up; this surface only diagnoses. Never throws on degenerate input
 * (silence, single-sample, length-mismatched channels).
 *
 * Thresholds are calibrated against measured genre mixes (post-fix trap
 * low-end 74.6 %, drill 78.3 %, house 69.2 %, dnb 51.9 %; crests 9.9–15.9 dB;
 * HF+air 7–10 %): red = the pre-fix disaster zone, yellow = advisory for the
 * legitimately low-heavy genres.
 */

export interface MixBandShares {
  /** Energy share 0..1 per band (mono downmix): <60, 60–120, 120–350, 350–2k, 2k–6k, 6k–12k, >12k Hz. */
  sub: number;
  low: number;
  lowmid: number;
  mid: number;
  himid: number;
  high: number;
  air: number;
}

export interface MixHealthFlag {
  severity: "red" | "yellow";
  check: string;
  detail: string;
}

export interface MixHealthReport {
  durationSec: number;
  peak: number;
  /** Samples at/over the clipping edge (|v| ≥ 0.9995). */
  clippedSamples: number;
  /** Distance from full scale in dB (positive = headroom). */
  headroomDb: number;
  crestDb: number;
  dcOffset: number;
  /** BS.1770 gated integrated loudness; null under one 400 ms block or silence. */
  integratedLufs: number | null;
  momentaryMaxLufs: number | null;
  bandShares: MixBandShares;
  /** sub + low combined share — the low-end dominance read. */
  lowEndShare: number;
  stereoCorrelation: number | null;
  flags: MixHealthFlag[];
  /** No red flags. Yellow is advisory, not a failure. */
  ok: boolean;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ cookbook 2nd-order Butterworth (Q = 1/√2) low/high shelf-free prototype. */
function rbjLowHigh(type: "lp" | "hp", freq: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate / 2 - 1)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  if (type === "lp") {
    return {
      b0: (1 - cos) / 2 / a0,
      b1: (1 - cos) / a0,
      b2: (1 - cos) / 2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Streaming biquad — processes a length in place mathematically (no copy). */
function biquadPower(data: Float32Array, chain: Biquad[]): number {
  let sumSq = 0;
  const st = chain.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    for (let f = 0; f < chain.length; f++) {
      const c = chain[f];
      const s = st[f];
      const y = c.b0 * v + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
      s.x2 = s.x1;
      s.x1 = v;
      s.y2 = s.y1;
      s.y1 = y;
      v = y;
    }
    sumSq += v * v;
  }
  return sumSq;
}

const CLIP_EDGE = 0.9995;
const LOW_END_RED = 0.82;
const LOW_END_YELLOW = 0.74;
const HF_YELLOW = 0.28;
const CREST_RED_DB = 6;
const CREST_YELLOW_DB = 8;
const DC_RED = 1e-3;
const SILENCE_RMS = 1e-4;

/**
 * Mix-health analysis over rendered channel buffers. Channels may be of
 * unequal length (the shortest bounds the scan); at least one channel is
 * required. For stereo inputs the correlation is the sample correlation
 * between L and R.
 */
export function analyzeMixHealth(channels: readonly Float32Array[], sampleRate: number): MixHealthReport {
  const empty: MixBandShares = { sub: 0, low: 0, lowmid: 0, mid: 0, himid: 0, high: 0, air: 0 };
  if (channels.length === 0 || sampleRate <= 0 || !Number.isFinite(sampleRate)) {
    return {
      durationSec: 0,
      peak: 0,
      clippedSamples: 0,
      headroomDb: 120,
      crestDb: 120,
      dcOffset: 0,
      integratedLufs: null,
      momentaryMaxLufs: null,
      bandShares: empty,
      lowEndShare: 0,
      stereoCorrelation: null,
      flags: [{ severity: "yellow", check: "no-signal", detail: "no channels to analyze" }],
      ok: false,
    };
  }
  const length = channels.reduce((acc, ch) => Math.min(acc, ch.length), Number.MAX_SAFE_INTEGER);

  // Whole-buffer readings: peak / clip / DC / RMS (all channels).
  let peak = 0;
  let clipped = 0;
  let dcSum = 0;
  let sampleCount = 0;
  let sumSq = 0;
  let finite = true;
  for (const ch of channels) {
    for (let i = 0; i < length; i++) {
      const v = ch[i];
      if (!Number.isFinite(v)) finite = false;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= CLIP_EDGE) clipped += 1;
      dcSum += v;
      sumSq += v * v;
      sampleCount += 1;
    }
  }
  const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;
  const dcOffset = sampleCount > 0 ? dcSum / sampleCount : 0;
  const crestDb = rms > 0 && peak > 0 ? 20 * Math.log10(peak / rms) : 120;
  const headroomDb = peak > 0 ? -20 * Math.log10(peak) : 120;

  // Mono downmix for band shares — a running array only for the downmix.
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let acc = 0;
    for (const ch of channels) acc += ch[i];
    mono[i] = acc / channels.length;
  }
  const totalSq = biquadPower(mono, []);
  const bandShares: MixBandShares = { ...empty };
  if (totalSq > 0) {
    const bands: Array<[keyof MixBandShares, Biquad[]]> = [
      ["sub", [rbjLowHigh("lp", 60, sampleRate)]],
      ["low", [rbjLowHigh("hp", 60, sampleRate), rbjLowHigh("lp", 120, sampleRate)]],
      ["lowmid", [rbjLowHigh("hp", 120, sampleRate), rbjLowHigh("lp", 350, sampleRate)]],
      ["mid", [rbjLowHigh("hp", 350, sampleRate), rbjLowHigh("lp", 2000, sampleRate)]],
      ["himid", [rbjLowHigh("hp", 2000, sampleRate), rbjLowHigh("lp", 6000, sampleRate)]],
      ["high", [rbjLowHigh("hp", 6000, sampleRate), rbjLowHigh("lp", 12000, sampleRate)]],
      ["air", [rbjLowHigh("hp", 12000, sampleRate)]],
    ];
    for (const [name, chain] of bands) {
      bandShares[name] = biquadPower(mono, chain) / totalSq;
    }
  }
  const lowEndShare = bandShares.sub + bandShares.low;
  const hfShare = bandShares.high + bandShares.air;

  // Stereo correlation (only meaningful for 2 channels of equal work).
  let stereoCorrelation: number | null = null;
  if (channels.length >= 2) {
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < length; i++) {
      lr += channels[0][i] * channels[1][i];
      ll += channels[0][i] * channels[0][i];
      rr += channels[1][i] * channels[1][i];
    }
    stereoCorrelation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
  }

  // BS.1770 loudness — null when unmeasurable (short or silent).
  const loudness =
    length >= Math.ceil(0.4 * sampleRate) ? analyzeLoudnessBuffer(channels as Float32Array[], sampleRate) : null;
  const integratedLufs = loudness?.measured ? loudness.integrated : null;
  const momentaryMaxLufs = loudness?.measured ? loudness.momentaryMax : null;

  // ── Flags ────────────────────────────────────────────────────────────────
  const flags: MixHealthFlag[] = [];
  if (!finite) flags.push({ severity: "red", check: "non-finite", detail: "render contains non-finite samples" });
  if (clipped > 0) flags.push({ severity: "red", check: "clipping", detail: `${clipped} samples at/over full scale` });
  if (peak > 1)
    flags.push({
      severity: "red",
      check: "over-full-scale",
      detail: `peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`,
    });
  if (Math.abs(dcOffset) >= DC_RED)
    flags.push({ severity: "red", check: "dc-offset", detail: `DC ${(dcOffset * 1000).toFixed(1)} mV` });
  if (crestDb < CREST_RED_DB)
    flags.push({
      severity: "red",
      check: "crest-collapse",
      detail: `crest ${crestDb.toFixed(1)} dB — over-compressed`,
    });
  if (lowEndShare > LOW_END_RED)
    flags.push({
      severity: "red",
      check: "low-end-dominance",
      detail: `sub+low ${(lowEndShare * 100).toFixed(0)} % of energy — mix will clip and mud`,
    });
  if (stereoCorrelation !== null && stereoCorrelation < -0.2)
    flags.push({
      severity: "red",
      check: "stereo-phase",
      detail: `L/R correlation ${stereoCorrelation.toFixed(2)} — phase inversion`,
    });

  if (peak > 0.991 && peak <= 1)
    flags.push({ severity: "yellow", check: "no-headroom", detail: `peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS` });
  if (crestDb >= CREST_RED_DB && crestDb < CREST_YELLOW_DB)
    flags.push({ severity: "yellow", check: "crest-low", detail: `crest ${crestDb.toFixed(1)} dB` });
  if (lowEndShare > LOW_END_YELLOW && lowEndShare <= LOW_END_RED)
    flags.push({
      severity: "yellow",
      check: "low-end-heavy",
      detail: `sub+low ${(lowEndShare * 100).toFixed(0)} % — fine for trap/drill, watch the bass`,
    });
  if (hfShare > HF_YELLOW)
    flags.push({
      severity: "yellow",
      check: "hf-heavy",
      detail: `high+air ${(hfShare * 100).toFixed(0)} % — harshness risk`,
    });
  if (rms < SILENCE_RMS)
    flags.push({
      severity: "yellow",
      check: "near-silent",
      detail: `RMS ${(20 * Math.log10(Math.max(rms, 1e-12))).toFixed(0)} dBFS`,
    });

  return {
    durationSec: length / sampleRate,
    peak,
    clippedSamples: clipped,
    headroomDb,
    crestDb,
    dcOffset,
    integratedLufs,
    momentaryMaxLufs,
    bandShares,
    lowEndShare,
    stereoCorrelation,
    flags,
    ok: !flags.some((flag) => flag.severity === "red"),
  };
}

/** AudioBuffer convenience wrapper (the export/render callers' shape). */
export function analyzeMixHealthBuffer(buffer: AudioBuffer): MixHealthReport {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return analyzeMixHealth(channels, buffer.sampleRate);
}

/* ── Auto-fix derivation (wave: mix-doctor auto-fix) ─────────────────────── */

export interface MixAutoFix {
  /** Tilt to install on the master (clamped ±4 — the applyMasterConfig clamp). */
  tiltDb: number;
  /** Master gain delta in linear terms (for clipping/over-hot mixes). */
  masterGain: number;
  /** Human-readable summary of what the fix does. */
  label: string;
}

/**
 * PURE derivation of a conservative one-click fix from a mix report. Only
 * the two mechanically-safe problems are corrected:
 *   - low-end dominance → dark tilt (energy moves below the muddiness line
 *     is what a human engineer does first: tilt down the lows, not scoop);
 *   - clipping / over-full-scale → master IN gain so the peak lands at
 *     −1 dBFS (the AutoStageButton convention).
 * Everything else (crest collapse, phase, DC, HF harshness) is REPORTED,
 * never auto-corrected — those need an ear, not a formula. Deterministic,
 * no state; the caller decides whether to apply. Returns null when the
 * report has no mechanical fix to offer.
 */
export function deriveMixAutoFix(report: MixHealthReport): MixAutoFix | null {
  const fixes: string[] = [];
  let tiltDb = 0;
  let masterGain = 1;

  // Low-end dominance: tilt toward dark in proportion to the excess over the
  // 74 % advisory line, 1 dB tilt per 3 % of excess, capped at −4 dB total
  // (the master tilt clamp). Only when the report is otherwise playable.
  if (report.lowEndShare > 0.74 && report.clippedSamples === 0) {
    tiltDb = Math.min(4, (report.lowEndShare - 0.74) / 0.03);
    fixes.push(`tilt ${tiltDb.toFixed(1)} dB`);
  }

  // Clipping / over-full-scale: master IN so the peak sits at −1 dBFS.
  if (report.clippedSamples > 0 || report.peak > 1) {
    masterGain = Math.pow(10, -1 / 20) / Math.max(report.peak, 1e-6);
    fixes.push("master gain to −1 dBFS");
  } else if (report.peak > 0.991) {
    masterGain = Math.pow(10, -1 / 20) / report.peak;
    fixes.push("master gain to −1 dBFS");
  }

  if (fixes.length === 0) return null;
  return {
    tiltDb: Math.round(tiltDb * 10) / 10,
    masterGain: Math.round(masterGain * 1000) / 1000,
    label: fixes.join(" + "),
  };
}

/**
 * The ONE-LINE verdict for an export read-back (per-render mix-doctor):
 * pass/issues summary, the numbers an agent can act on (integrated LUFS,
 * low-end share, crest, headroom), flagged issues by severity, and the
 * derived auto-fix when one exists. Deterministic from the report — the
 * same report always yields the same line, in tests and in transports.
 */
export function buildMixCheckVerdict(report: MixHealthReport): string {
  const red = report.flags.filter((f) => f.severity === "red");
  const yellow = report.flags.filter((f) => f.severity === "yellow");
  const head = red.length === 0 ? "MIX CHECK PASS" : `MIX CHECK — ${red.length} ISSUE${red.length > 1 ? "S" : ""} —`;
  const lufs = report.integratedLufs != null ? `${report.integratedLufs.toFixed(1)} LUFS` : "LUFS n/a";
  const stats = `${lufs} · low ${(report.lowEndShare * 100).toFixed(0)}% · crest ${report.crestDb.toFixed(1)} dB · peak −${report.headroomDb.toFixed(1)} dBFS`;
  const notes = [...red, ...yellow].map((f) => `${f.severity === "red" ? "⚠" : "○"} ${f.check}: ${f.detail}`);
  const fix = deriveMixAutoFix(report);
  const parts = [head, stats];
  if (notes.length > 0) parts.push(notes.join(" · "));
  if (fix != null) parts.push(`suggested fix: ${fix.label} (apply via master config, then re-export to verify)`);
  return parts.join(" — ");
}
