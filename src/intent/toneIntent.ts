/**
 * Tone intent (ADR 0016/0018 intent surface): "play the tone" / "tune tone
 * to 880" / "stop the tone" — drives the CLAP tone fixture through the
 * player (clap-player → --set → PARAM_VALUE) and the EXT PCM chain. The
 * shared playback controller arbitrates: a new play retunes/stops whatever
 * the chip or a previous verb started.
 *
 * Detection is tone-stem-scoped with a play/tune/stop verb or an explicit
 * Hz number; bare "ton" alone never matches (English "ton" is not a plugin).
 */

export interface ToneIntent {
  kind: "play" | "tune" | "stop";
  freq: number; // Hz, the fixture's parameter
}

const deaccent = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const TONE_STEM = /\b(?:tone|ton)\b/;
const STOP_VERB = /\b(?:stop|kill|silence|stopn\w*|vypni|zastav|ticho)\b/;
const TUNE_VERB = /\b(?:tune|tune\s+it|retune|nalad\w*|dolad\w*|posun)\b/;
const HZ_NUMBER = /(\d{2,4})\s*(?:hz)?\b/;

/** Detect a tone intent in free text. Null = not this feature. */
export function parseToneIntent(text: string, currentFreq = 440): ToneIntent | null {
  const lower = deaccent(text);
  if (!lower.trim() || !TONE_STEM.test(lower)) return null;

  const hz = HZ_NUMBER.exec(lower)?.[1];
  const freq = hz !== undefined ? Math.min(2000, Math.max(50, Number(hz))) : currentFreq;

  if (STOP_VERB.test(lower)) return { kind: "stop", freq: currentFreq };
  // "play the tone at 880" is a PLAY with a frequency, not a retune.
  if (/\b(?:play|hraj|pust)\b/.test(lower)) return { kind: "play", freq };
  if (TUNE_VERB.test(lower) || (hz !== undefined && TONE_STEM.test(lower))) {
    return { kind: "tune", freq };
  }
  return null;
}
