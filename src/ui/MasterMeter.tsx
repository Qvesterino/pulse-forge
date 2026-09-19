import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { ChannelLevels } from "../audio-engine/metering";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { evaluateMasterVerdict, evaluateMixCheck, MIN_DB } from "../audio-engine/metering";
import { Goniometer } from "./Goniometer";
import { LoudnessHistory } from "./LoudnessHistory";
import { SpectrumAnalyzer } from "./SpectrumAnalyzer";
import { setMasterConfig } from "../commands/commands";

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
  lrImbalanceDb: number;
  warnings: ReturnType<typeof evaluateMixCheck>;
}

const EMPTY: ChannelLevels = { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 };

/** Streaming-target option labels for the print-ready verdict headline. */
const TARGET_LABELS: Record<number, string> = { 14: "SPOTIFY", 12: "YOUTUBE", 9: "CLUB", 7: "LOUD" };

/**
 * Master metering wall: spectrum + loudness history in the centre, goniometer
 * + print-ready verdict on the right. Pulls fresh frames from the engine on a
 * ~30 Hz loop so the UI is light. The stereo indicators (L/R + GR, correlation,
 * headroom) live in the MASTER channel strip — see MasterStereoMeters.
 */
export function MasterMeter() {
  const services = useServices();
  const doc = useDoc();
  const ceilingDb = doc.master.ceilingDb;
  const lufsTarget = doc.master.lufsTarget ?? -14;
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
    lrImbalanceDb: 0,
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
        // Clip state follows the same true-peak policy as mix warnings. A
        // sample peak below 0 dBFS can still intersample-clip, while a
        // conservative -0.3 dB sample threshold created false red flashes.
        const truePeakDb = snapshot?.truePeakDb ?? peakDb;
        const nowOver = truePeakDb > -0.1 || peakDb > 0;
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
          Math.abs(prev.truePeakDb - truePeakDb) > 0.2 ||
          Math.abs(prev.lufsMomentary - (snapshot?.lufsMomentary ?? MIN_DB)) > 0.2 ||
          Math.abs(prev.lufsShortTerm - (snapshot?.lufsShortTerm ?? MIN_DB)) > 0.2 ||
          Math.abs(prev.lufsIntegrated - (snapshot?.lufsIntegrated ?? MIN_DB)) > 0.2 ||
          Math.abs(prev.monoLossDb - (snapshot?.monoLossDb ?? 0)) > 0.2 ||
          Math.abs(prev.gainReductionDb - gainReductionDb) > 0.15 ||
          Math.abs(prev.lrImbalanceDb - imbalance) > 0.3 ||
          prev.warnings.length !== warnings.length ||
          prev.clipping !== clipping;
        if (changed) {
          const next: ReadState = {
            left,
            right,
            correlation: levels.correlation,
            peakHoldDb,
            clipping,
            truePeakDb,
            lufsMomentary: snapshot?.lufsMomentary ?? MIN_DB,
            lufsShortTerm: snapshot?.lufsShortTerm ?? MIN_DB,
            lufsIntegrated: snapshot?.lufsIntegrated ?? MIN_DB,
            monoLossDb: snapshot?.monoLossDb ?? 0,
            gainReductionDb,
            lrImbalanceDb: imbalance,
            warnings,
          };
          lastStateRef.current = next;
          setState(next);
        }
      }
    });
    return () => unregisterRaf("master-meter");
  }, [services]);

  const verdict = evaluateMasterVerdict(
    {
      lufsIntegrated: state.lufsIntegrated,
      truePeakDb: state.truePeakDb,
      monoLossDb: state.monoLossDb,
      correlation: state.correlation,
      lrImbalanceDb: state.lrImbalanceDb,
    },
    lufsTarget,
    ceilingDb,
    TARGET_LABELS[Math.round(-lufsTarget)] ?? "",
  );

  return (
    <div className="master-meter" role="group" aria-label="Master meter">
      <div className="master-zone-center">
        <SpectrumAnalyzer
          analyser={
            (
              services.engine as unknown as { getMasterSpectrumAnalyser?: () => AnalyserNode | null }
            ).getMasterSpectrumAnalyser?.() ?? null
          }
          height={72}
          accent="#f59e0b"
          id="master"
          fillHeight
        />
        <div className="master-loudness-readout" aria-label="Master loudness">
          <span>LUFS-M {formatDb(state.lufsMomentary)}</span>
          <span>LUFS-S {formatDb(state.lufsShortTerm)}</span>
          <span>LUFS-I {formatDb(state.lufsIntegrated)}</span>
          <span>TP {formatDb(state.truePeakDb)} dBTP</span>
          <span>MONO LOSS {formatDb(state.monoLossDb)} dB</span>
          <span title="Master-stage gain reduction">GR {state.gainReductionDb.toFixed(1)} dB</span>
        </div>
        <LoudnessHistory id="master-loudness" height={56} targetLufs={lufsTarget} />
      </div>

      <div className="master-zone-right">
        <Goniometer
          analysers={
            (
              services.engine as unknown as {
                getMasterStereoAnalysers?: () => { l: AnalyserNode; r: AnalyserNode } | null;
              }
            ).getMasterStereoAnalysers?.() ?? null
          }
          id="master"
        />
        <div className="master-verdict" data-level={verdict.level}>
          <span className="master-verdict-headline">{verdict.headline}</span>
          {/* Fixed-height slots: hints appearing or disappearing must never
              resize the goniometer above (layout stability). */}
          <div className="master-verdict-hints">
            {verdict.hints.map((hint) => (
              <span key={hint} className="master-verdict-hint">
                {hint}
              </span>
            ))}
          </div>
          <div className="master-verdict-target">
            <span className="master-verdict-target-label">TARGET</span>
            <select
              value={String(lufsTarget)}
              onChange={(e) => services.store.execute(setMasterConfig(doc, { lufsTarget: Number(e.target.value) }))}
              aria-label="LUFS target"
            >
              <option value="-14">-14 LUFS (Spotify)</option>
              <option value="-12">-12 LUFS (YouTube)</option>
              <option value="-9">-9 LUFS (Club)</option>
              <option value="-7">-7 LUFS (Loud)</option>
            </select>
            <span
              className="master-verdict-delta"
              title="LUFS integrated target ±1 dB (true peak limiter already via look-ahead limiter + true peak meter)"
            >
              {state.lufsIntegrated <= -119
                ? "—"
                : Math.abs(state.lufsIntegrated - lufsTarget) <= 1
                  ? "✓ ±1 OK"
                  : `Δ ${(state.lufsIntegrated - lufsTarget).toFixed(1)} dB`}
            </span>
          </div>
          <div className="master-verdict-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => services.engine.resetMasterIntegratedLufs?.()}
            >
              RESET INTEGRATED
            </button>
            <button
              type="button"
              className="btn btn-small"
              title="Auto gain stage to -6 dB below ceiling (pulls master IN so peaks sit at ceiling-6 dB)"
              onClick={() => {
                const snap = (
                  services.engine as unknown as { getMasterMeterSnapshot?: () => MasterSnapshot }
                ).getMasterMeterSnapshot?.();
                const peak = snap ? Math.max(snap.peakHoldDb, snap.truePeakDb) : state.peakHoldDb;
                if (!Number.isFinite(peak) || peak <= -60) return;
                const targetPeak = ceilingDb - 6;
                const delta = targetPeak - peak;
                const currentGain = doc.master.masterGain ?? 1;
                const newGain = Math.max(0, Math.min(2, currentGain * Math.pow(10, delta / 20)));
                services.store.execute(setMasterConfig(doc, { masterGain: newGain }));
              }}
            >
              AUTO -6dB
            </button>
          </div>
        </div>
      </div>

      {/* Always mounted: a reserved warnings row keeps the wall from jumping
          when mix-check messages appear or clear. */}
      <div className="master-mix-check master-zone-warnings" role="status">
        {state.warnings.map((warning) => (
          <span key={warning.code}>{warning.message}</span>
        ))}
      </div>
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

interface StereoState {
  left: ChannelLevels;
  right: ChannelLevels;
  correlation: number;
  peakHoldDb: number;
  gainReductionDb: number;
  clipping: boolean;
}

/**
 * Stereo indicator cluster — L/R peak/RMS bars with limiter GR, correlation
 * and headroom. Used to be the metering wall's dynamics column; now it fills
 * the dead space under the MASTER strip's IN/CEIL controls. Self-polling on
 * the same ~30 Hz engine snapshot the wall reads (the getter is a cheap
 * snapshot copy, and per-meter loops are the established pattern here), so
 * the strip meters keep running even when the wall is unmounted.
 */
export function MasterStereoMeters() {
  const services = useServices();
  const doc = useDoc();
  const ceilingDb = doc.master.ceilingDb;
  const [state, setState] = useState<StereoState>({
    left: { ...EMPTY },
    right: { ...EMPTY },
    correlation: 1,
    peakHoldDb: -120,
    gainReductionDb: 0,
    clipping: false,
  });
  const lastStateRef = useRef(state);
  const clipHoldRef = useRef(0);

  useEffect(() => {
    let lastRead = 0;
    registerRaf("master-stereo-meters", (t) => {
      if (t - lastRead < 33) return;
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
      // Same true-peak clip policy as the wall: a sample peak below 0 dBFS
      // can still intersample-clip.
      const truePeakDb = snapshot?.truePeakDb ?? peakDb;
      const nowOver = truePeakDb > -0.1 || peakDb > 0;
      if (nowOver) clipHoldRef.current = 0;
      clipHoldRef.current += 0.033;
      const clipping = clipHoldRef.current < 0.6;
      const gainReductionDb =
        Math.round((snapshot ? snapshot.gainReductionDb : (services.engine.getMasterGainReductionDb?.() ?? 0)) * 10) /
        10;

      const prev = lastStateRef.current;
      const changed =
        Math.abs(prev.left.peakDb - left.peakDb) > 0.2 ||
        Math.abs(prev.right.peakDb - right.peakDb) > 0.2 ||
        Math.abs(prev.left.rmsDb - left.rmsDb) > 0.4 ||
        Math.abs(prev.right.rmsDb - right.rmsDb) > 0.4 ||
        Math.abs(prev.correlation - levels.correlation) > 0.02 ||
        Math.abs(prev.peakHoldDb - peakHoldDb) > 0.2 ||
        Math.abs(prev.gainReductionDb - gainReductionDb) > 0.15 ||
        prev.clipping !== clipping;
      if (changed) {
        const next: StereoState = {
          left,
          right,
          correlation: levels.correlation,
          peakHoldDb,
          gainReductionDb,
          clipping,
        };
        lastStateRef.current = next;
        setState(next);
      }
    });
    return () => unregisterRaf("master-stereo-meters");
  }, [services]);

  return (
    <div className="master-stereo-meters" role="group" aria-label="Master stereo indicators">
      <div className="master-dynamics-meters">
        <MeterChannel label="L" level={state.left} holdDb={state.peakHoldDb} gainReductionDb={state.gainReductionDb} />
        <MeterChannel label="R" level={state.right} holdDb={state.peakHoldDb} gainReductionDb={state.gainReductionDb} />
      </div>
      {/* CORR + HEAD share one row — stacked they ate strip height without
          adding resolution at these sizes. */}
      <div className="master-stereo-secondary">
        <CorrelationMeter value={state.correlation} />
        <HeadroomStrip ceilingDb={ceilingDb} clipping={state.clipping} />
      </div>
    </div>
  );
}

function formatDb(value: number): string {
  return value <= -119 ? "-INF" : value.toFixed(1);
}

function MeterChannel({
  label,
  level,
  holdDb,
  gainReductionDb,
}: {
  label: string;
  level: ChannelLevels;
  holdDb: number;
  gainReductionDb: number;
}) {
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
        {/* Limiter gain reduction, drawn from the top like classic mastering meters. */}
        {gainReductionDb > 0.05 && (
          <div
            className="master-channel-gr"
            style={{ height: `${Math.min(100, (gainReductionDb / 12) * 100)}%` }}
            title={`Limiter working — ${gainReductionDb.toFixed(1)} dB gain reduction`}
          />
        )}
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
