/** Compatibility re-exports. The shared delivery contract lives in src/mastering. */
export {
  MASTER_PROFILES,
  CUSTOM_PROFILE,
  evaluateDelivery,
  isMasterProfileId,
  profileFor,
  resolveDeliveryTarget,
  verdictAgainst,
  worstStatus,
} from "../mastering/profiles";
export type { DeliveryCheck as PlatformVerdict, MasterProfile } from "../mastering/profiles";

/** CODEC LOSS VERDICT — the pre-encode vs post-codec comparison.
 * The transport layer encodes (LAME MP3), decodes (WebCodecs), measures both
 * sides, and feeds the numbers here. Pure and deterministic.
 *
 * MP3 at ≥192 kbps typically: preserves LUFS within ±0.3, ADDS true-peak
 * overshoot (up to +1-2 dBTP for hot masters), and cuts everything above
 * ~16-20 kHz. The verdict grades each delta. */
export interface CodecLossInput {
  preLufs: number | null;
  postLufs: number | null;
  preTruePeakDb: number;
  postTruePeakDb: number;
  /** Optional pre/post high-band share for the codec-cutoff read. */
  preHfShare?: number | null;
  postHfShare?: number | null;
}

export interface CodecLossVerdict {
  status: "pass" | "warn" | "fail";
  line: string;
}

export function codecLossVerdict(input: CodecLossInput): CodecLossVerdict[] {
  const out: CodecLossVerdict[] = [];
  if (input.preLufs != null && input.postLufs != null) {
    const d = Math.abs(input.postLufs - input.preLufs);
    if (d > 1)
      out.push({ status: "fail", line: `codec LUFS shifted ${d.toFixed(1)} LU — the encode changed the loudness` });
    else if (d > 0.3) out.push({ status: "warn", line: `codec LUFS shifted ${d.toFixed(1)} LU` });
    else out.push({ status: "pass", line: `codec LUFS within ${d.toFixed(1)} LU of the pre-encode master` });
  }
  const tpAdded = input.postTruePeakDb - input.preTruePeakDb;
  if (tpAdded > 1)
    out.push({
      status: "fail",
      line: `codec ADDED ${tpAdded.toFixed(1)} dB of true-peak overshoot — reduce the pre-encode ceiling`,
    });
  else if (tpAdded > 0.3)
    out.push({ status: "warn", line: `codec added ${tpAdded.toFixed(1)} dB of true-peak overshoot` });
  else out.push({ status: "pass", line: `codec true-peak overshoot ${tpAdded.toFixed(1)} dB — within tolerance` });
  if (input.preHfShare != null && input.postHfShare != null) {
    const hfLoss = input.preHfShare - input.postHfShare;
    if (hfLoss > 0.05)
      out.push({
        status: "warn",
        line: `codec removed ${(hfLoss * 100).toFixed(0)}% of high-band energy (expected — MP3 cuts above ~16 kHz)`,
      });
    else out.push({ status: "pass", line: `high-band content survived the codec` });
  }
  return out;
}
