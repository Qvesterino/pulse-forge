import type { McpFxMeterReading, McpFxMeterSnapshot, McpMeterSnapshot } from "./tools";
import type { Services } from "../services";
import type { EffectInstance } from "../project-model/types";
import { MASTER_EFFECT_OWNER_ID } from "../project-model/types";
import { EFFECT_DEFS } from "../effects/registry";

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

/**
 * KYX MCP — FX TELEMETRY BRIDGE (kyx_meter scope:"fx").
 *
 * The closed loop for an effect change: after an agent applies KOREŇ, it can
 * read the tracked f0, the "+x dB harmonics" gain and the key scaler instead
 * of assuming the effect did something. Walks every insert host — track effects
 * (groups are tracks), return effects and the master chain
 * (`MASTER_EFFECT_OWNER_ID`) — and asks the engine's own per-effect meter cache
 * (`getFxMeters`) and dynamics breakdown, so this helper adds NO DSP knowledge:
 * it reports exactly what the wrappers expose and nothing else.
 *
 * Null when the engine has no live context (honest refusal), and a throwing
 * engine call degrades to null rather than taking the relay down.
 */
export function mcpFxMetersFromServices(services: Services): McpFxMeterSnapshot | null {
  try {
    const engine = services.engine;
    if (engine.getLiveAudioContext() === null) return null;
    const doc = services.store.getDoc();
    const effects: McpFxMeterReading[] = [];
    const collect = (ownerId: string, ownerName: string, list: readonly EffectInstance[]): void => {
      for (const fx of list) {
        // One misbehaving runtime must not blind the whole snapshot: its
        // telemetry degrades to null, the rest still report.
        let meters: unknown = null;
        let gainReduction: McpFxMeterReading["gainReduction"] = null;
        try {
          meters = engine.getFxMeters(ownerId, fx.id) ?? null;
          gainReduction = engine.getFxGainReductionBreakdown(ownerId, fx.id) ?? null;
        } catch {
          meters = null;
          gainReduction = null;
        }
        effects.push({
          ownerId,
          ownerName,
          fxId: fx.id,
          type: fx.type,
          name: EFFECT_DEFS[fx.type]?.name ?? String(fx.type),
          bypassed: fx.bypassed === true,
          meters,
          gainReduction,
        });
      }
    };
    for (const track of doc.tracks) collect(track.id, track.name, track.effects);
    for (const ret of doc.returns) collect(ret.id, ret.name, ret.effects);
    collect(MASTER_EFFECT_OWNER_ID, "master", doc.master.effects ?? []);
    return { effects };
  } catch {
    return null; // engine not booted — the tool refuses honestly
  }
}
