/**
 * Krumhansl-Schmuckler key profiles (classic weights).
 *
 * Same numeric profiles as audiokey-analyzer `src/dsp/keyProfiles.ts` and the
 * `KEY_PROFILE_MAJOR/MINOR` constants in beat_modifier `pipelines/analysis.py`
 * — the literature reference both codebases share.
 *
 * Scoring uses Pearson correlation here (audiokey). beat_modifier uses cosine
 * correlation; the F1 test fixtures decide the winner — see open item [D] in
 * docs/REFERENCE-MAP-ROADMAP.md.
 */

/* eslint-disable prettier/prettier -- tabular profile data stays readable aligned */
export const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;

export const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;
/* eslint-enable prettier/prettier */

/** Rotate a 12-element profile so that `tonic` becomes index 0 reference. */
export function rotateProfile(profile: readonly number[], tonic: number): number[] {
  const out = new Array<number>(12);
  for (let i = 0; i < 12; i++) out[i] = profile[(i - tonic + 12) % 12];
  return out;
}

/** Pearson correlation between two equal-length vectors. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}
