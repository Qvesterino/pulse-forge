/**
 * QVESTER AUDIO PROFILE BUS — live publisher on channel `pulse_forge`.
 *
 * While the transport plays, KYX periodically publishes a BOUNDED analysis
 * window (≤10 s of energy / beat / band curves) to the ecosystem's ambient
 * audio-profile bus (`qvester:audio-profile:v1:pulse_forge`, schema
 * "qvester.audio-profile-bus/v1"). Audio-reactive sibling apps subscribe and
 * loop the curves locally against their own render time (see the Qvester
 * canvas-virtuoso signals service) — per-frame audio NEVER crosses apps.
 *
 * Sampling reuses the live engine's existing analysers — no new DSP:
 *   energy     = master RMS (getMasterLevels, ~30 Hz gate on the shared RAF)
 *   bands      = the master spectrogram analyser's FFT bins summed into five
 *                fixed bands (bass/lowMid/mid/highMid/high), dB → [0,1]
 *   beat       = the transport's own beat grid (position ticks / PPQ) — the
 *                scheduler IS the beat authority, so the curve is exact
 *
 * Publishing mirrors the Qvester publisher contract: envelope "2.0"-style
 * schema key, monotonic per-channel revision, 30 min TTL, quota-safe write.
 * On studio close the channel is cleared (the documented sign-out path) so
 * sibling apps stop looping a dead session's window.
 */
import { PPQ } from "../project-model/types";
import type { Services } from "../services";
import { registerRaf, unregisterRaf } from "../services/rafLoop";

export const PROFILE_BUS_CHANNEL = "pulse_forge";
const PROFILE_BUS_KEY = `qvester:audio-profile:v1:${PROFILE_BUS_CHANNEL}`;
const PROFILE_BUS_SCHEMA = "qvester.audio-profile-bus/v1";
export const PROFILE_BUS_PUBLISHER_APP = "pulse_forge";

const WINDOW_SEC = 10;
const SAMPLE_HZ = 30;
const WINDOW_SAMPLES = WINDOW_SEC * SAMPLE_HZ;
const PUBLISH_INTERVAL_MS = 3000;
const MIN_WINDOW_SEC = 2;
const TICK_GATE_MS = 33;
const TTL_MS = 30 * 60 * 1000;
/** dB window for FFT band normalization (full-scale sine sits near −3..0). */
const DB_FLOOR = -90;
const DB_CEIL = -10;
/** Master RMS runs ~0.02–0.35 on typical mixes — gain it into a lively curve. */
const ENERGY_GAIN = 3;
/** A beat "hit" occupies the first 15 % of its grid cell in the beat curve. */
const BEAT_PULSE_FRACTION = 0.15;

const BAND_NAMES = ["bass", "lowMid", "mid", "highMid", "high"] as const;
const BAND_EDGES_HZ: Array<[number, number]> = [
  [20, 120],
  [120, 500],
  [500, 2000],
  [2000, 6000],
  [6000, 24000],
];

export interface ProfileBusCurveWindow {
  energy: Float32Array;
  beat: Float32Array;
  bands: Record<(typeof BAND_NAMES)[number], Float32Array>;
  /** Number of valid samples (≤ WINDOW_SAMPLES), oldest-first from index 0. */
  filled: number;
  durationSec: number;
}

/** dBFS value → clamped [0,1] unit over the DB_FLOOR..DB_CEIL window. */
export function dbToUnit(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const t = (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Beat-grid curve sample: a sawtooth pulse that peaks on the grid line. */
export function beatPulseSample(beatPhase: number): number {
  if (beatPhase < BEAT_PULSE_FRACTION) return 1 - beatPhase / BEAT_PULSE_FRACTION;
  return 0;
}

/** Average a band's FFT bins (dBFS) into one clamped [0,1] unit. */
export function bandLevel(dbBins: Float32Array, fromBin: number, toBin: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, fromBin); i < toBin && i < dbBins.length; i++) {
    sum += dbToUnit(dbBins[i]!);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Downsample a filled ring window to ≤600 frames, oldest-first. */
export function windowToCurve(ring: Float32Array, filled: number): number[] {
  const usable = Math.min(filled, WINDOW_SAMPLES, 600);
  if (usable <= 0) return [];
  const out: number[] = [];
  const startIdx = filled <= WINDOW_SAMPLES ? 0 : filled % WINDOW_SAMPLES;
  for (let i = 0; i < usable; i++) {
    const v = ring[(startIdx + i) % WINDOW_SAMPLES]!;
    out.push(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  }
  return out;
}

export interface PublisherProfile {
  bands: Record<string, number>;
  bpm: number;
  beatPhase: number;
  duration: number;
  sampleRate: number;
  energyCurve: number[];
  beatCurve: number[];
  bandCurves: Record<string, number[]>;
  /** Optional metadata block (beat-locked handoff v2, 2026-09-25). Old
   *  consumers ignore this; new consumers read it for phase alignment +
   *  genre hints. Only set when KYX can supply the values (rendered
   *  project with active pattern). */
  meta?: PublisherProfileMeta;
}

export interface PublisherProfileMeta {
  /** Offset of the first beat from t=0 in seconds. 0 = grid beat 0.
   *  Consumers use this to align their own beat curves to KYX's. */
  beatGridOffsetSec: number;
  /** Active pattern's `PatternGeneration.genre`, or null. */
  genre: string | null;
  /** 0..1 tempo confidence. */
  bpmConfidence: number;
}

/** Assemble the bus profile from the current window (contract-shaped). */
export function buildProfileFromWindow(
  window: ProfileBusCurveWindow,
  meta: {
    bpm: number;
    beatPhase: number;
    latestBands: Record<string, number>;
    beatMeta?: PublisherProfileMeta;
  },
): PublisherProfile {
  const bandCurves: Record<string, number[]> = {};
  for (const name of BAND_NAMES) bandCurves[name] = windowToCurve(window.bands[name]!, window.filled);
  const profile: PublisherProfile = {
    bands: { ...meta.latestBands },
    bpm: Number.isFinite(meta.bpm) && meta.bpm > 0 ? meta.bpm : 0,
    beatPhase: Math.min(1, Math.max(0, meta.beatPhase)),
    duration: Math.min(window.durationSec, WINDOW_SEC),
    sampleRate: SAMPLE_HZ,
    energyCurve: windowToCurve(window.energy, window.filled),
    beatCurve: windowToCurve(window.beat, window.filled),
    bandCurves,
  };
  if (meta.beatMeta) profile.meta = meta.beatMeta;
  return profile;
}

function writeEnvelope(profile: PublisherProfile, channel: string = PROFILE_BUS_CHANNEL): boolean {
  const storageKey = `qvester:audio-profile:v1:${channel}`;
  let revision = 1;
  try {
    const previous = localStorage.getItem(storageKey);
    if (previous) {
      const parsed = JSON.parse(previous) as { revision?: number };
      if (typeof parsed.revision === "number" && parsed.revision >= revision) revision = parsed.revision + 1;
    }
  } catch {
    /* fresh channel */
  }
  const now = Date.now();
  const envelope = {
    schema: PROFILE_BUS_SCHEMA,
    channel,
    revision,
    publisherApp: PROFILE_BUS_PUBLISHER_APP,
    capturedAt: new Date(now).toISOString(),
    expiresAt: now + TTL_MS,
    profile,
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * Beat-locked handoff v2 (2026-09-25): publish a stem sub-channel
 * envelope. One call per stem group (rhythm/bass/melody). The sub-channel
 * shape mirrors the master `PublisherProfile` but with a `meta.stemRole`
 * + `meta.parentRevision` linking back to the master envelope.
 */
export interface StemProfileMeta extends PublisherProfileMeta {
  stemRole: "rhythm" | "bass" | "melody";
  parentRevision: number;
  parentChannel: typeof PROFILE_BUS_CHANNEL;
}

export interface StemProfileInput {
  role: "rhythm" | "bass" | "melody";
  /** Decoded mono PCM samples in [-1, 1]. */
  samples: Float32Array;
  /** Sample rate of `samples` (Hz). */
  sampleRate: number;
  /** Master envelope revision this stem is published alongside. */
  parentRevision: number;
  beatMeta?: PublisherProfileMeta;
}

/** Build a stem PublisherProfile from raw mono PCM. Lightweight: no FFT
 *  (stems don't need 5-band resolution for the visual layers), only an
 *  RMS energy curve. Reuses the master's beat curve since the beat
 *  grid is transport-derived and identical across stems. */
export function buildStemProfileFromPcm(input: StemProfileInput): PublisherProfile {
  const { samples, sampleRate, role, parentRevision, beatMeta } = input;
  const windowSize = Math.max(1, Math.floor(sampleRate / SAMPLE_HZ));
  const curveLength = Math.min(samples.length / windowSize, 600);
  const energyCurve: number[] = new Array(Math.floor(curveLength)).fill(0);
  for (let i = 0; i < curveLength; i++) {
    const start = i * windowSize;
    let sum = 0;
    const end = Math.min(start + windowSize, samples.length);
    for (let j = start; j < end; j++) sum += samples[j]! * samples[j]!;
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    energyCurve[i] = Math.min(1, Math.max(0, rms * ENERGY_GAIN));
  }
  // Use the stem-energy curve as both energy and beat placeholders —
  // a future iteration can split onset detection from RMS. The visual
  // consumers want *energy pulses per stem*; beat-precision is the
  // master's responsibility.
  const profile: PublisherProfile = {
    bands: {},
    bpm: 0,
    beatPhase: 0,
    duration: samples.length / sampleRate,
    sampleRate: SAMPLE_HZ,
    energyCurve,
    beatCurve: energyCurve,
    bandCurves: {},
  };
  if (beatMeta || true) {
    profile.meta = {
      beatGridOffsetSec: beatMeta?.beatGridOffsetSec ?? 0,
      genre: beatMeta?.genre ?? null,
      bpmConfidence: beatMeta?.bpmConfidence ?? 0.9,
      stemRole: role,
      parentRevision,
      parentChannel: PROFILE_BUS_CHANNEL,
    } as StemProfileMeta;
  }
  return profile;
}

/** Write a stem profile envelope on its sub-channel (e.g.
 *  `pulse_forge/rhythm`). Idempotent — overwrite is the standard publish
 *  semantic. Best-effort: storage errors are swallowed so the handoff
 *  sender never breaks on a quota. */
export function publishStemProfile(stem: StemProfileInput): boolean {
  const channel = `${PROFILE_BUS_CHANNEL}/${stem.role}`;
  const profile = buildStemProfileFromPcm(stem);
  return writeEnvelope(profile, channel);
}

/** Drop all stem envelopes for a clean sign-out (matches master sign-out). */
export function clearStemProfiles(): void {
  for (const role of ["rhythm", "bass", "melody"] as const) {
    const storageKey = `qvester:audio-profile:v1:${PROFILE_BUS_CHANNEL}/${role}`;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* storage unavailable */
    }
  }
}

export interface QvesterProfileBusHandle {
  stop: () => void;
}

const BAND_BIN_EDGES: Array<[number, number]> = BAND_EDGES_HZ;

/**
 * Start the live publisher. Idempotent (a second start returns the running
 * handle). Register from the studio mount; call `stop()` on unmount to
 * clear the channel (sibling apps stop looping our window).
 */
export function startQvesterProfileBus(services: Services): QvesterProfileBusHandle {
  // Idempotent: StrictMode double-mounts the studio — one publisher max.
  const previous = (startQvesterProfileBus as { handle?: QvesterProfileBusHandle }).handle;
  if (previous) return previous;

  const engine = services.engine as Services["engine"] & {
    getMasterLevels: () => { left: { rms: number }; right: { rms: number } };
    getMasterSpectrogramAnalyser: () => AnalyserNode;
  };

  let fft = new Float32Array(2048);
  let bandEdges: Array<[number, number]> | null = null;
  const energy = new Float32Array(WINDOW_SAMPLES);
  const beat = new Float32Array(WINDOW_SAMPLES);
  const bands: Record<string, Float32Array> = {};
  for (const name of BAND_NAMES) bands[name] = new Float32Array(WINDOW_SAMPLES);

  let writeIdx = 0;
  let filled = 0;
  let lastSampleAt = 0;
  let lastPublishAt = 0;
  let running = true;

  const tick = (timestamp: number) => {
    if (!running) return;
    if (timestamp - lastSampleAt < TICK_GATE_MS) return;
    lastSampleAt = timestamp;
    try {
      if (!services.transport.playing) return;

      // ── sample ──
      const levels = engine.getMasterLevels();
      const energySample = Math.min(1, Math.max(0, Math.max(levels.left.rms, levels.right.rms) * ENERGY_GAIN));

      const analyser = engine.getMasterSpectrogramAnalyser() as AnalyserNode | null;
      if (!analyser) return;
      if (analyser.frequencyBinCount !== fft.length) fft = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(fft);
      if (!bandEdges) {
        const nyquist = analyser.context.sampleRate / 2;
        const binHz = analyser.context.sampleRate / (analyser.frequencyBinCount * 2);
        bandEdges = BAND_BIN_EDGES.map(([lo, hi]) => [
          Math.max(1, Math.floor(lo / binHz)),
          Math.min(fft.length, Math.ceil(Math.min(hi, nyquist) / binHz)),
        ]);
      }
      const latestBands: Record<string, number> = {};
      BAND_NAMES.forEach((name, i) => {
        const [from, to] = bandEdges![i]!;
        latestBands[name] = bandLevel(fft, from, to);
      });

      const beats = services.transport.position / PPQ;
      const beatPhase = beats - Math.floor(beats);

      // ── roll window ──
      energy[writeIdx] = energySample;
      beat[writeIdx] = beatPulseSample(beatPhase);
      BAND_NAMES.forEach((name) => {
        bands[name]![writeIdx] = latestBands[name]!;
      });
      writeIdx = (writeIdx + 1) % WINDOW_SAMPLES;
      filled = Math.min(filled + 1, WINDOW_SAMPLES);

      // ── publish gate ──
      const windowSec = filled / SAMPLE_HZ;
      if (windowSec >= MIN_WINDOW_SEC && timestamp - lastPublishAt >= PUBLISH_INTERVAL_MS) {
        lastPublishAt = timestamp;
        const doc = services.store.getDoc();
        const bpm = doc.bpm;
        const window: ProfileBusCurveWindow = { energy, beat, bands, filled, durationSec: windowSec };
        writeEnvelope(buildProfileFromWindow(window, { bpm, beatPhase, latestBands }));
      }
    } catch {
      /* the bus must never break the studio */
    }
  };

  registerRaf("qvester-profile-bus", tick);

  const handle: QvesterProfileBusHandle = {
    stop: () => {
      running = false;
      unregisterRaf("qvester-profile-bus");
      (startQvesterProfileBus as { handle?: QvesterProfileBusHandle }).handle = undefined;
      try {
        // Publisher sign-out: siblings stop looping our window.
        localStorage.removeItem(PROFILE_BUS_KEY);
      } catch {
        /* storage already gone */
      }
      // Beat-locked v2 (2026-09-25): also drop stem sub-channels.
      clearStemProfiles();
    },
  };
  (startQvesterProfileBus as { handle?: QvesterProfileBusHandle }).handle = handle;
  return handle;
}
