import type { MixBandShares } from "../analysis/mixDoctor";

export type TonalBandId = "sub" | "low" | "lowmid" | "mid" | "himid" | "high" | "air";

export interface TonalBandShareRow {
  band: TonalBandId;
  label: string;
  hz: string;
  mixDb: number;
  refDb: number;
  /** Reference minus mix, in dB of each side's own band-energy share. */
  deltaDb: number;
  /** Both sides are below the participation floor relative to their own peak band. */
  empty: boolean;
}

/** Below this floor, band differences are mostly filter leakage. */
export const MATCH_PARTICIPATION_FLOOR_DB = 30;

const BAND_DEFS: readonly Pick<TonalBandShareRow, "band" | "label" | "hz">[] = [
  { band: "sub", label: "Sub", hz: "20–60 Hz" },
  { band: "low", label: "Low", hz: "60–120 Hz" },
  { band: "lowmid", label: "Low-mid", hz: "120–350 Hz" },
  { band: "mid", label: "Mid", hz: "350 Hz–2 kHz" },
  { band: "himid", label: "High-mid", hz: "2–6 kHz" },
  { band: "high", label: "High", hz: "6–12 kHz" },
  { band: "air", label: "Air", hz: "12 kHz+" },
];

const round1 = (value: number): number => Math.round(value * 10) / 10;
const dbOfShare = (share: number): number => (share > 1e-12 ? 10 * Math.log10(share) : -120);

/** Compare already-measured band shares without processing their PCM again. */
export function compareMixBandShares(mixShares: MixBandShares, refShares: MixBandShares): TonalBandShareRow[] {
  const rows = BAND_DEFS.map(({ band, label, hz }) => {
    const mixDb = round1(dbOfShare(mixShares[band]));
    const refDb = round1(dbOfShare(refShares[band]));
    return { band, label, hz, mixDb, refDb, deltaDb: round1(refDb - mixDb) };
  });
  const mixLoudest = Math.max(...rows.map((row) => row.mixDb));
  const refLoudest = Math.max(...rows.map((row) => row.refDb));
  const quietOn = (db: number, loudest: number): boolean => db < loudest - MATCH_PARTICIPATION_FLOOR_DB;
  return rows.map((row) => ({
    ...row,
    empty: quietOn(row.mixDb, mixLoudest) && quietOn(row.refDb, refLoudest),
  }));
}
