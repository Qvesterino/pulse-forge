export type MasteringAlbumGainPlanStatus = "applied" | "loudness-unavailable" | "true-peak-unavailable";

export interface MasteringAlbumGainPlan {
  status: MasteringAlbumGainPlanStatus;
  targetLufs: number;
  truePeakCeilingDbtp: number;
  maximumGainDb: number;
  sourceLufs: number | null;
  sourceTruePeakDbtp: number | null;
  requestedGainDb: number | null;
  appliedGainDb: number;
  peakLimited: boolean;
  maximumGainLimited: boolean;
  targetReached: boolean;
}

/** Compute a static gain adjustment; the peak guard can only reduce requested gain. */
export function planMasteringAlbumGainAdjustment(input: {
  targetLufs: number;
  truePeakCeilingDbtp: number;
  maximumGainDb: number;
  sourceLufs: number | null;
  sourceTruePeakDbtp: number | null;
}): MasteringAlbumGainPlan {
  const { targetLufs, truePeakCeilingDbtp, maximumGainDb, sourceLufs, sourceTruePeakDbtp } = input;
  if (!Number.isFinite(targetLufs) || targetLufs < -24 || targetLufs > -6) {
    throw new Error("Album loudness target must be between −24 and −6 LUFS-I.");
  }
  if (!Number.isFinite(truePeakCeilingDbtp) || truePeakCeilingDbtp < -6 || truePeakCeilingDbtp > 0) {
    throw new Error("Album true-peak ceiling must be between −6 and 0 dBTP.");
  }
  if (!Number.isFinite(maximumGainDb) || maximumGainDb < 0 || maximumGainDb > 24) {
    throw new Error("Album maximum gain must be between 0 and 24 dB.");
  }
  if (sourceLufs !== null && (!Number.isFinite(sourceLufs) || sourceLufs < -200 || sourceLufs > 100)) {
    throw new Error("Album source loudness measurement is invalid.");
  }
  if (
    sourceTruePeakDbtp !== null &&
    (!Number.isFinite(sourceTruePeakDbtp) || sourceTruePeakDbtp < -200 || sourceTruePeakDbtp > 100)
  ) {
    throw new Error("Album source true-peak measurement is invalid.");
  }

  const measuredLufs = sourceLufs !== null && sourceLufs > -119;
  if (sourceTruePeakDbtp === null) {
    return {
      status: "true-peak-unavailable",
      targetLufs,
      truePeakCeilingDbtp,
      maximumGainDb,
      sourceLufs: measuredLufs ? sourceLufs : null,
      sourceTruePeakDbtp: null,
      requestedGainDb: measuredLufs ? targetLufs - sourceLufs : null,
      appliedGainDb: 0,
      peakLimited: false,
      maximumGainLimited: false,
      targetReached: false,
    };
  }

  const peakPermittedGainDb = truePeakCeilingDbtp - sourceTruePeakDbtp;
  const requestedGainDb = measuredLufs ? targetLufs - sourceLufs : null;
  const desiredGainDb = requestedGainDb ?? 0;
  const appliedGainDb = Math.min(desiredGainDb, maximumGainDb, peakPermittedGainDb);
  const peakLimited = measuredLufs ? peakPermittedGainDb < desiredGainDb - 0.005 : appliedGainDb < -0.005;
  const maximumGainLimited = measuredLufs && maximumGainDb < desiredGainDb - 0.005;

  return {
    status: measuredLufs ? "applied" : "loudness-unavailable",
    targetLufs,
    truePeakCeilingDbtp,
    maximumGainDb,
    sourceLufs: measuredLufs ? sourceLufs : null,
    sourceTruePeakDbtp,
    requestedGainDb,
    appliedGainDb,
    peakLimited,
    maximumGainLimited,
    targetReached: measuredLufs && Math.abs(appliedGainDb - desiredGainDb) <= 0.005,
  };
}

/** Apply the planned linear gain in place so batch export does not duplicate the PCM buffer. */
export function applyMasteringAlbumGainInPlace(buffer: AudioBuffer, gainDb: number): void {
  if (!Number.isFinite(gainDb) || gainDb < -200 || gainDb > 24) {
    throw new Error("Album gain adjustment is outside the supported range.");
  }
  if (gainDb === 0) return;
  const linearGain = 10 ** (gainDb / 20);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index++) {
      const adjusted = samples[index]! * linearGain;
      if (!Number.isFinite(adjusted)) throw new Error("Album gain adjustment produced a non-finite audio sample.");
      samples[index] = adjusted;
    }
  }
}
