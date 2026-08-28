import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { ChannelLevels } from "../audio-engine/metering";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { evaluateMixCheck, MIN_DB } from "../audio-engine/metering";
import { Goniometer } from "./Goniometer";
import { SpectrumAnalyzer } from "./SpectrumAnalyzer";

interface ReadState {
  left: ChannelLevels;
  right: ChannelLevels;
  correlation: number;
  peakHoldDb: number;
  clipping: boolean;
  truePeakDb: number;
  lufsMomentary: number;
  lufsShortTerm: number;
  lufsIntegrated: number;
  monoLossDb: number;
  gainReductionDb: number;
  warnings: ReturnType<typeof evaluateMixCheck>;
}

const EMPTY: ChannelLevels = { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 };

/**
 * Stereo master meter with L/R peak + RMS bars, peak hold ticks, a ×Corr
 * correlation block, and a CLIP warning. Pulls fresh frames from the engine
 * on a ~30 Hz loop so the UI is light.
 */
export function MasterMeter() {
  const services = useServices();
  const doc = useDoc();
  const ceilingDb = doc.master.ceilingDb;
  const [state, setState] = useState<ReadState>({
    left: { ...EMPTY },
    right: { ...EMPTY },
    correlation: 1,
    peakHoldDb: -120,
    clipping: false,
    truePeakDb: MIN_DB,
    lufsMomentary: MIN_DB,
    lufsShortTerm: MIN_DB,
    lufsIntegrated: MIN_DB,
    monoLossDb: 0,
    gainReductionDb: 0,
    warnings: [],
  });
  const lastStateRef = useRef(state);
  const clipHoldRef = useRef(0);
  const phaseSinceRef = useRef<number | null>(null);
  const imbalanceSinceRef = useRef<number | null>(null);

  useEffect(() => {
    let lastRead = 0;
    registerRaf("master-meter", (t) => {
      if (t - lastRead >= 33) {
        lastRead = t;
        const engineWithMeter = services.engine as typeof services.engine & {
          getMasterMeterSnapshot?: () => MasterSnapshot;
        };
        const snapshot = engineWithMeter.getMasterMeterSnapshot?.();
        const levels = snapshot ?? services.engine.getMasterLevels();
        const peakHoldDb = snapshot?.peakHoldDb ?? services.engine.getMasterPeakHoldDb();
        const left = levels.left;
        const right = levels.right;
        const peakDb = Math.max(left.peakDb, right.peakDb);
        const nowOver = peakDb > -0.3;
        if (nowOver) clipHoldRef.current = 0;
        clipHoldRef.current += 0.033;
        const clipping = clipHoldRef.current < 0.6;
        const phaseSince = levels.correlation < 0 ? (phaseSinceRef.current ?? t) : null;
        const imbalance = snapshot?.lrImbalanceDb ?? Math.abs(left.rmsDb - right.rmsDb);
        const imbalanceSince = imbalance > 6 ? (imbalanceSinceRef.current ?? t) : null;
        phaseSinceRef.current = phaseSince;
        imbalanceSinceRef.current = imbalanceSince;
        const gainReductionDb =
          Math.round((snapshot ? snapshot.gainReductionDb : services.engine.getMasterGainReductionDb()) * 10) / 10;
        const warnings = snapshot
          ? evaluateMixCheck({
              truePeakDb: snapshot.truePeakDb,
              correlation: snapshot.correlation,
              monoLossDb: snapshot.monoLossDb,
              lrImbalanceDb: imbalance,
              phaseDurationMs: phaseSince === null ? 0 : t - phaseSince,
              imbalanceDurationMs: imbalanceSince === null ? 0 : t - imbalanceSince,
            })
          : [];

        const prev = lastStateRef.current;
        const changed =
          Math.abs(prev.left.peakDb - left.peakDb) > 0.2 ||
          Math.abs(prev.right.peakDb - right.peakDb) > 0.2 ||
          Math.abs(prev.left.rmsDb - left.rmsDb) > 0.4 ||
          Math.abs(prev.right.rmsDb - right.rmsDb) > 0.4 ||
          Math.abs(prev.correlation - levels.correlation) > 0.02 ||
          Math.abs(prev.peakHoldDb - peakHoldDb) > 0.2 ||
          Math.abs(prev.truePeakDb - (snapshot?.truePeakDb ?? peakDb)) > 0.2 ||
          Math.abs(prev.lufsMomentary - (snapshot?.lufsMomentary ?? MIN_DB)) > 0.2 ||
          Math.abs(prev.lufsShortTerm - (snapshot?.lufsShortTerm ?? MIN_DB)) > 0.2 ||
          Math.abs(prev.lufsIntegrated - (snapshot?.lufsIntegrated ?? MIN_DB)) > 0.2 ||
          Math.abs(prev.monoLossDb - (snapshot?.monoLossDb ?? 0)) > 0.2 ||
          Math.abs(prev.gainReductionDb - gainReductionDb) > 0.15 ||
          prev.warnings.length !== warnings.length ||
          prev.clipping !== clipping;
        if (changed) {
          const next: ReadState = {
            left,
            right,
            correlation: levels.correlation,
            peakHoldDb,
            clipping,
            truePeakDb: snapshot?.truePeakDb ?? peakDb,
            lufsMomentary: snapshot?.lufsMomentary ?? MIN_DB,
            lufsShortTerm: snapshot?.lufsShortTerm ?? MIN_DB,
            lufsIntegrated: snapshot?.lufsIntegrated ?? MIN_DB,
            monoLossDb: snapshot?.monoLossDb ?? 0,
            gainReductionDb,
            warnings,
          };
          lastStateRef.current = next;
          setState(next);
        }
      }
    });
    return () => unregisterRaf("master-meter");
  }, [services]);

  return (
    <div className="master-meter" role="group" aria-label="Master meter">
      <MeterChannel label="L" level={state.left} holdDb={state.peakHoldDb} />
      <MeterChannel label="R" level={state.right} holdDb={state.peakHoldDb} />
      <CorrelationMeter value={state.correlation} />
      <Goniometer
        analysers={
          (
            services.engine as unknown as {
              getMasterStereoAnalysers?: () => { l: AnalyserNode; r: AnalyserNode } | null;
            }
          ).getMasterStereoAnalysers?.() ?? null
        }
        size={72}
        id="master"
      />
      <HeadroomStrip ceilingDb={ceilingDb} clipping={state.clipping} />
      <div className="master-loudness-readout" aria-label="Master loudness">
        <span>LUFS-M {formatDb(state.lufsMomentary)}</span>
        <span>LUFS-S {formatDb(state.lufsShortTerm)}</span>
        <span>LUFS-I {formatDb(state.lufsIntegrated)}</span>
        <span>TP {formatDb(state.truePeakDb)} dBTP</span>
        <span>MONO LOSS {formatDb(state.monoLossDb)} dB</span>
        <span title="Master-stage gain reduction">GR {state.gainReductionDb.toFixed(1)} dB</span>
        <button type="button" className="btn btn-small" onClick={() => services.engine.resetMasterIntegratedLufs?.()}>
          RESET INTEGRATED
        </button>
      </div>
      <SpectrumAnalyzer
        analyser={
          (
            services.engine as unknown as { getMasterSpectrumAnalyser?: () => AnalyserNode | null }
          ).getMasterSpectrumAnalyser?.() ?? null
        }
        height={64}
        accent="#f59e0b"
        id="master"
      />
      {state.warnings.length > 0 && (
        <div className="master-mix-check" role="status">
          {state.warnings.map((warning) => (
            <span key={warning.code}>{warning.message}</span>
          ))}
        </div>
      )}
      {state.clipping && (
        <span className="master-clip-warning" role="alert" title="Master is clipping — pull down IN or engage LIMIT">
          CLIP
        </span>
      )}
    </div>
  );
}

interface MasterSnapshot {
  left: ChannelLevels;
  right: ChannelLevels;
  correlation: number;
  peakHoldDb: number;
  truePeakDb: number;
  lufsMomentary: number;
  lufsShortTerm: number;
  lufsIntegrated: number;
  monoLossDb: number;
  lrImbalanceDb: number;
  gainReductionDb: number;
}

function formatDb(value: number): string {
  return value <= -119 ? "-INF" : value.toFixed(1);
}

function MeterChannel({ label, level, holdDb }: { label: string; level: ChannelLevels; holdDb: number }) {
  const peakPct = dbToPct(level.peakDb);
  const rmsPct = dbToPct(level.rmsDb);
  const holdPct = dbToPct(holdDb);
  return (
    <div className="master-channel">
      <span className="master-channel-label">{label}</span>
      <div className="master-channel-bar">
        <div className="master-channel-rms" style={{ height: `${rmsPct}%` }} />
        <div className="master-channel-peak" style={{ height: `${peakPct}%` }} />
        <div className="master-channel-hold" style={{ bottom: `${holdPct}%` }} />
        <div className="master-channel-tick" style={{ bottom: `${dbToPct(0)}%` }} />
        <div className="master-channel-tick master-channel-tick-warn" style={{ bottom: `${dbToPct(-3)}%` }} />
        <div className="master-channel-tick master-channel-tick-dim" style={{ bottom: `${dbToPct(-6)}%` }} />
        <div className="master-channel-tick master-channel-tick-dim" style={{ bottom: `${dbToPct(-12)}%` }} />
        <div className="master-channel-tick master-channel-tick-dim" style={{ bottom: `${dbToPct(-24)}%` }} />
      </div>
      <span className="master-channel-peak-readout" title="Peak">
        {level.peakDb <= -120 ? "−∞" : level.peakDb.toFixed(1)}
      </span>
    </div>
  );
}

function CorrelationMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, ((value + 1) / 2) * 100));
  const label = value > 0.5 ? "MONO+OK" : value < 0 ? "PHASE" : "WIDE";
  const color = value < 0 ? "#f87171" : value < 0.2 ? "#f59e0b" : "#4ade80";
  return (
    <div className="master-correlation" title="Stereo correlation (1 = mono, -1 = out of phase)">
      <span className="master-channel-label">×CORR</span>
      <div className="master-correlation-bar">
        <div className="master-correlation-track" />
        <div className="master-correlation-center" />
        <div className="master-correlation-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="master-correlation-label" style={{ color }}>
        {label}
      </span>
    </div>
  );
}

function HeadroomStrip({ ceilingDb, clipping }: { ceilingDb: number; clipping: boolean }) {
  const color = clipping ? "#f87171" : ceilingDb > -3 ? "#f59e0b" : "#4ade80";
  return (
    <div className="master-headroom" title="Headroom to the limiter ceiling">
      <span className="master-channel-label">HEAD</span>
      <div className="master-headroom-strip">
        <div className="master-headroom-bar" style={{ background: color }} />
        <div className="master-headroom-ceiling" style={{ bottom: `${dbToPct(ceilingDb)}%` }} />
      </div>
      <span className="master-headroom-readout">{ceilingDb.toFixed(1)} dB</span>
    </div>
  );
}

function dbToPct(db: number): number {
  const clamped = Math.max(-48, Math.min(6, db));
  return ((clamped + 48) / 54) * 100;
}
