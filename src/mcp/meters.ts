import type { McpMeterSnapshot } from "./tools";
import type { Services } from "../services";
import { MASTER_EFFECT_OWNER_ID } from "../project-model/types";

/**
 * KYX MCP — METER BRIDGE (kyx_meter's ears, docs/INTENT-MCP-EXPANSION-PLAN.md
 * P0 "analysis reads"). Maps the LIVE engine onto the tool snapshot: master
 * from the shared BS.1770 meter pipeline (`getMasterMeterSnapshot` — true
 * peak, LUFS M/S/I, correlation), per-track peak/RMS pulled from each
 * track's own post-fader analyser (`getSpectrogramTrackAnalyser`).
 *
 * Returns null when the engine has no live audio context — the tool refuses
 * honestly instead of inventing numbers. Throwing engine calls are caught:
 * metering must never take the relay down (the bridge crash guard is the
 * second net).
 */
export function mcpMeterSnapshotFromServices(services: Services): McpMeterSnapshot | null {
  try {
    const engine = services.engine;
    const master = engine.getMasterMeterSnapshot();
    const toDb = (linear: number): number => (linear > 0 ? 20 * Math.log10(linear) : -120);
    const snapshot: McpMeterSnapshot = {
      master: {
        truePeakDb: master.truePeakDb,
        rmsDb: Math.max(toDb(master.left.rms), toDb(master.right.rms)),
        lufsMomentary: master.lufsMomentary,
        lufsShortTerm: master.lufsShortTerm,
        lufsIntegrated: master.lufsIntegrated,
        correlation: master.correlation,
        clipping: master.truePeakDb >= 0,
      },
      tracks: [],
      masterRuntime: {
        available: engine.getLiveAudioContext() !== null,
        degradedStages: engine.getDegradedMasterStages(),
        degradedInserts: engine
          .getDegradedFx()
          .filter((effect) => effect.trackId === MASTER_EFFECT_OWNER_ID)
          .map(({ fxId, reason }) => ({ fxId, reason })),
      },
    };
    for (const track of services.store.getDoc().tracks) {
      const analyser = engine.getSpectrogramTrackAnalyser(track.id);
      if (analyser == null) continue;
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) {
        const sample = buf[i];
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
        sumSquares += sample * sample;
      }
      snapshot.tracks.push({
        id: track.id,
        name: track.name,
        peakDb: toDb(peak),
        rmsDb: toDb(Math.sqrt(sumSquares / buf.length)),
        clipping: peak >= 1,
      });
    }
    return snapshot;
  } catch {
    return null; // engine not booted / context suspended — honest refusal
  }
}
