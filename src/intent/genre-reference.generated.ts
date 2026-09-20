/**
 * PLACEHOLDER — overwritten by `npm run references:genres`. Neutral values so
 * the song builder import resolves before the first measurement run.
 */

export const SONG_LOUDNESS_TARGET_LUFS = -14;

export const SONG_LOUDNESS_TRIM_LIMIT_DB = 6;

export interface GenreSongReference {
  /** Integrated loudness (LUFS) of the untrimmed reference render. */
  integrated: number;
  /** Peak-to-loudness ratio (dB) — transient headroom of the full mix. */
  punchPlrDb: number;
  /** Tonal tilt (dB): 10·log10(low≤220Hz / high≥4kHz), positive = low-heavy. */
  tiltDb: number;
  /** Reference song length in bars. */
  bars: number;
}

export const GENRE_REFERENCE: Record<string, GenreSongReference> = {
  house: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  techno: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  trap: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  ambient: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  drill: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  phonk: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  jersey: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
  dnb: { integrated: -14, punchPlrDb: 0, tiltDb: 0, bars: 0 },
};
