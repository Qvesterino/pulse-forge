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
}

/** Assemble the bus profile from the current window (contract-shaped). */
export function buildProfileFromWindow(
  window: ProfileBusCurveWindow,
  meta: { bpm: number; beatPhase: number; latestBands: Record<string, number> },
): PublisherProfile {
  const bandCurves: Record<string, number[]> = {};
  for (const name of BAND_NAMES) bandCurves[name] = windowToCurve(window.bands[name]!, window.filled);
  return {
    bands: { ...meta.latestBands },
    bpm: Number.isFinite(meta.bpm) && meta.bpm > 0 ? meta.bpm : 0,
    beatPhase: Math.min(1, Math.max(0, meta.beatPhase)),
    duration: Math.min(window.durationSec, WINDOW_SEC),
    sampleRate: SAMPLE_HZ,
    energyCurve: windowToCurve(window.energy, window.filled),
    beatCurve: windowToCurve(window.beat, window.filled),
    bandCurves,
  };
}

function writeEnvelope(profile: PublisherProfile): boolean {
  let revision = 1;
  try {
    const previous = localStorage.getItem(PROFILE_BUS_KEY);
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
    channel: PROFILE_BUS_CHANNEL,
    revision,
    publisherApp: PROFILE_BUS_PUBLISHER_APP,
    capturedAt: new Date(now).toISOString(),
    expiresAt: now + TTL_MS,
    profile,
  };
  try {
    localStorage.setItem(PROFILE_BUS_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
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
        const bpm = services.store.getDoc().bpm;
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
    },
  };
  (startQvesterProfileBus as { handle?: QvesterProfileBusHandle }).handle = handle;
  return handle;
}
