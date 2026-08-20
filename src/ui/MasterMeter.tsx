import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { ChannelLevels } from "../audio-engine/metering";

interface ReadState {
  left: ChannelLevels;
  right: ChannelLevels;
  correlation: number;
  peakHoldDb: number;
  clipping: boolean;
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
  });
  const lastReadRef = useRef(0);
  const lastStateRef = useRef(state);
  const clipHoldRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      if (t - lastReadRef.current >= 33) {
        lastReadRef.current = t;
        const levels = services.engine.getMasterLevels();
        const peakHoldDb = services.engine.getMasterPeakHoldDb();
        const left = levels.left;
        const right = levels.right;
        const peakDb = Math.max(left.peakDb, right.peakDb);
        const nowOver = peakDb > -0.3;
        if (nowOver) clipHoldRef.current = 0;
        clipHoldRef.current += 0.033;
        const clipping = clipHoldRef.current < 0.6;

        const prev = lastStateRef.current;
        const changed =
          Math.abs(prev.left.peakDb - left.peakDb) > 0.2 ||
          Math.abs(prev.right.peakDb - right.peakDb) > 0.2 ||
          Math.abs(prev.left.rmsDb - left.rmsDb) > 0.4 ||
          Math.abs(prev.right.rmsDb - right.rmsDb) > 0.4 ||
          Math.abs(prev.correlation - levels.correlation) > 0.02 ||
          Math.abs(prev.peakHoldDb - peakHoldDb) > 0.2 ||
          prev.clipping !== clipping;
        if (changed) {
          const next: ReadState = { left, right, correlation: levels.correlation, peakHoldDb, clipping };
          lastStateRef.current = next;
          setState(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [services]);

  return (
    <div className="master-meter" role="group" aria-label="Master meter">
      <MeterChannel label="L" level={state.left} holdDb={state.peakHoldDb} />
      <MeterChannel label="R" level={state.right} holdDb={state.peakHoldDb} />
      <CorrelationMeter value={state.correlation} />
      <HeadroomStrip ceilingDb={ceilingDb} clipping={state.clipping} />
      {state.clipping && (
        <span className="master-clip-warning" role="alert" title="Master is clipping — pull down IN or engage LIMIT">
          CLIP
        </span>
      )}
    </div>
  );
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
      <span className="master-correlation-label" style={{ color }}>{label}</span>
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
