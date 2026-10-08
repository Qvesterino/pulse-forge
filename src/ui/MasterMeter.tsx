import { useEffect, useId, useRef, useState } from "react";
import { useMaster, useServices, useTracks } from "./context";
import type { ChannelLevels } from "../audio-engine/metering";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { evaluateMasterVerdict, evaluateMixCheck, MIN_DB } from "../audio-engine/metering";
import { Goniometer } from "./Goniometer";
import { LoudnessHistory } from "./LoudnessHistory";
import { SpectrumAnalyzer } from "./SpectrumAnalyzer";
import { Spectrogram } from "./Spectrogram";
import { setMasterConfig } from "../commands/commands";
import { MASTER_PROFILES, profileFor, resolveDeliveryTarget, type MasterProfileId } from "../mastering/profiles";

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
  glueReductionDb: number;
  lrImbalanceDb: number;
  warnings: ReturnType<typeof evaluateMixCheck>;
}

const EMPTY: ChannelLevels = { peak: 0, rms: 0, peakDb: -120, rmsDb: -120 };
const MASTER_CLIP_HOLD_MS = 600;
const STATUS_BAR_CLIP_HOLD_MS = 800;

/**
 * Master metering wall: spectrum + loudness history in the centre, goniometer
 * + print-ready verdict on the right. Pulls fresh frames from the engine on a
 * ~30 Hz loop so the UI is light. The stereo indicators (L/R + GR, correlation,
 * headroom) live in the MASTER channel strip — see MasterStereoMeters.
 */
export function MasterMeter() {
  const services = useServices();
  // Fine-grained selector (GOAL 04): MasterMeter only reads master config.
  const master = useMaster();
  // Spectrogram source picker: tracks + buses (useTracks is already typed
  // to exclude returns — those are FX sends, not mix content). "" = master.
  const tracks = useTracks();
  const spectroSources = tracks.map((t) => ({
    id: t.id,
    name: t.kind === "group" ? `BUS · ${t.name}` : t.name,
  }));
  const [spectroSource, setSpectroSource] = useState("");
  // A deleted track must not leave the select pointing at a ghost.
  const effectiveSpectroSource = spectroSources.some((s) => s.id === spectroSource) ? spectroSource : "";
  const ceilingDb = master.ceilingDb;
  const lufsTarget = master.lufsTarget ?? -14;
  const deliveryProfile = resolveDeliveryTarget(master);
  const profileId = master.deliveryProfileId ?? "streaming";
  const [customLufsDraft, setCustomLufsDraft] = useState(String(lufsTarget));
  const [customPeakDraft, setCustomPeakDraft] = useState(String(deliveryProfile.maxTruePeakDb));
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
    glueReductionDb: 0,
    lrImbalanceDb: 0,
    warnings: [],
  });
  const lastStateRef = useRef(state);
  const clipHoldUntilRef = useRef(0);
  const phaseSinceRef = useRef<number | null>(null);
  const imbalanceSinceRef = useRef<number | null>(null);

  useEffect(() => {
    setCustomLufsDraft(String(lufsTarget));
    setCustomPeakDraft(String(deliveryProfile.maxTruePeakDb));
  }, [lufsTarget, deliveryProfile.maxTruePeakDb]);

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
        if (nowOver) clipHoldUntilRef.current = t + MASTER_CLIP_HOLD_MS;
        const clipping = t < clipHoldUntilRef.current;
        const phaseSince = levels.correlation < 0 ? (phaseSinceRef.current ?? t) : null;
        const imbalance = snapshot?.lrImbalanceDb ?? Math.abs(left.rmsDb - right.rmsDb);
        const imbalanceSince = imbalance > 6 ? (imbalanceSinceRef.current ?? t) : null;
        phaseSinceRef.current = phaseSince;
        imbalanceSinceRef.current = imbalanceSince;
        const gainReductionDb =
          Math.round((snapshot ? snapshot.gainReductionDb : services.engine.getMasterGainReductionDb()) * 10) / 10;
        const engineWithGlue = services.engine as typeof services.engine & {
          getMasterGlueReductionDb?: () => number;
        };
        const glueReductionDb =
          Math.round(
            (snapshot && "glueReductionDb" in snapshot && typeof snapshot.glueReductionDb === "number"
              ? snapshot.glueReductionDb
              : (engineWithGlue.getMasterGlueReductionDb?.() ?? 0)) * 10,
          ) / 10;
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
          Math.abs(prev.glueReductionDb - glueReductionDb) > 0.15 ||
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
            glueReductionDb,
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
    deliveryProfile.label.toUpperCase(),
    deliveryProfile,
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
        <Spectrogram
          analyser={
            (
              services.engine as unknown as { getMasterSpectrogramAnalyser?: () => AnalyserNode | null }
            ).getMasterSpectrogramAnalyser?.() ?? null
          }
          taps={
            (
              services.engine as unknown as {
                getMasterSpectrogramTaps?: () => { low: AnalyserNode; mid: AnalyserNode; high: AnalyserNode } | null;
              }
            ).getMasterSpectrogramTaps?.() ?? null
          }
          stereoTaps={
            (
              services.engine as unknown as {
                getMasterSpectrogramStereoTaps?: () => { mid: AnalyserNode; side: AnalyserNode } | null;
              }
            ).getMasterSpectrogramStereoTaps?.() ?? null
          }
          sources={spectroSources}
          sourceId={effectiveSpectroSource}
          onSourceChange={setSpectroSource}
          getTrackAnalyser={
            (
              services.engine as unknown as {
                getSpectrogramTrackAnalyser?: (id: string) => AnalyserNode | null;
              }
            ).getSpectrogramTrackAnalyser?.bind(services.engine) ?? (() => null)
          }
          transport={services.transport}
          id="master"
        />
        <div className="master-loudness-readout" aria-label="Master loudness">
          <span>LUFS-M {formatDb(state.lufsMomentary)}</span>
          <span>LUFS-S {formatDb(state.lufsShortTerm)}</span>
          <span>LUFS-I {formatDb(state.lufsIntegrated)}</span>
          <span>TP {formatDb(state.truePeakDb)} dBTP</span>
          <span>MONO LOSS {formatDb(state.monoLossDb)} dB</span>
          <span title="Master-stage gain reduction">GR {state.gainReductionDb.toFixed(1)} dB</span>
          <span title="Master buss-glue gain reduction">GLUE {state.glueReductionDb.toFixed(1)} dB</span>
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
              value={profileId}
              onChange={(event) => {
                const id = event.target.value as MasterProfileId;
                const profile = profileFor(id);
                services.store.execute(
                  setMasterConfig(
                    services.store.getDoc(),
                    profile
                      ? {
                          deliveryProfileId: id,
                          lufsTarget: profile.targetLufs,
                          deliveryTruePeakDb: profile.maxTruePeakDb,
                        }
                      : { deliveryProfileId: "custom" },
                  ),
                );
              }}
              aria-label="Master delivery profile"
              title="Delivery profile changes measurement targets only. It does not change the audio processing."
            >
              {MASTER_PROFILES.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
              <option value="custom">Custom</option>
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
          <div className="master-delivery-note" title={deliveryProfile.intendedUse}>
            {profileId === "custom" ? "Custom delivery targets" : deliveryProfile.note}
          </div>
          {profileId === "custom" && (
            <div className="master-custom-targets" role="group" aria-label="Custom delivery targets">
              <label>
                LUFS-I
                <input
                  type="number"
                  min="-24"
                  max="0"
                  step="0.1"
                  value={customLufsDraft}
                  aria-label="Custom integrated loudness target in LUFS"
                  onChange={(event) => setCustomLufsDraft(event.target.value)}
                  onBlur={() => {
                    if (!customLufsDraft.trim()) return;
                    const value = Number(customLufsDraft);
                    if (!Number.isFinite(value)) return;
                    services.store.execute(
                      setMasterConfig(services.store.getDoc(), {
                        deliveryProfileId: "custom",
                        lufsTarget: Math.max(-24, Math.min(0, value)),
                      }),
                    );
                  }}
                />
              </label>
              <label>
                MAX TP dBTP
                <input
                  type="number"
                  min="-12"
                  max="0"
                  step="0.1"
                  value={customPeakDraft}
                  aria-label="Custom maximum true peak target in dBTP"
                  onChange={(event) => setCustomPeakDraft(event.target.value)}
                  onBlur={() => {
                    if (!customPeakDraft.trim()) return;
                    const value = Number(customPeakDraft);
                    if (!Number.isFinite(value)) return;
                    services.store.execute(
                      setMasterConfig(services.store.getDoc(), {
                        deliveryProfileId: "custom",
                        deliveryTruePeakDb: Math.max(-12, Math.min(0, value)),
                      }),
                    );
                  }}
                />
              </label>
            </div>
          )}
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
                const currentGain = master.masterGain ?? 1;
                const newGain = Math.max(0, Math.min(2, currentGain * Math.pow(10, delta / 20)));
                services.store.execute(setMasterConfig(services.store.getDoc(), { masterGain: newGain }));
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
  /** Master buss-glue reduction — present on fresh engine snapshots. */
  glueReductionDb?: number;
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
  const master = useMaster();
  const ceilingDb = master.ceilingDb;
  const [state, setState] = useState<StereoState>({
    left: { ...EMPTY },
    right: { ...EMPTY },
    correlation: 1,
    peakHoldDb: -120,
    gainReductionDb: 0,
    clipping: false,
  });
  const lastStateRef = useRef(state);
  const clipHoldUntilRef = useRef(0);

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
      if (nowOver) clipHoldUntilRef.current = t + MASTER_CLIP_HOLD_MS;
      const clipping = t < clipHoldUntilRef.current;
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

/**
 * Compact L/R master meter for the statusbar (ROADMAP-UI-2027, Vlna 3) —
 * the "never lose the music" FL lesson: the master level stays visible no
 * matter which dock panel is open. Peak fill with an RMS core, a peak-hold
 * line and a clip dot, fed by the same cheap engine snapshot the strip
 * meters read (25 Hz — statusbar chrome, not a mix-decision surface).
 */
export function MasterMiniMeter({
  onOpenAudioSettings,
  audioSettingsOpen,
}: {
  onOpenAudioSettings: () => void;
  audioSettingsOpen: boolean;
}) {
  const services = useServices();
  const meterDescriptionId = useId();
  const [state, setState] = useState({
    lPeak: -120,
    lRms: -120,
    rPeak: -120,
    rRms: -120,
    hold: -120,
    clip: false,
  });
  const lastStateRef = useRef(state);
  const clipHoldUntilRef = useRef(0);

  useEffect(() => {
    let lastRead = 0;
    registerRaf("master-mini-meter", (t) => {
      if (t - lastRead < 40) return;
      lastRead = t;
      const engineWithMeter = services.engine as typeof services.engine & {
        getMasterMeterSnapshot?: () => MasterSnapshot;
      };
      const snapshot = engineWithMeter.getMasterMeterSnapshot?.();
      const levels = snapshot ?? services.engine.getMasterLevels();
      const peakDb = Math.max(levels.left.peakDb, levels.right.peakDb);
      // Same intersample-clip policy as the wall and the strip meters.
      const truePeakDb = snapshot?.truePeakDb ?? peakDb;
      const nowOver = truePeakDb > -0.1 || peakDb > 0;
      if (nowOver) clipHoldUntilRef.current = t + STATUS_BAR_CLIP_HOLD_MS;
      const next = {
        lPeak: levels.left.peakDb,
        lRms: levels.left.rmsDb,
        rPeak: levels.right.peakDb,
        rRms: levels.right.rmsDb,
        hold: snapshot?.peakHoldDb ?? services.engine.getMasterPeakHoldDb(),
        clip: t < clipHoldUntilRef.current,
      };
      const prev = lastStateRef.current;
      const changed =
        Math.abs(prev.lPeak - next.lPeak) > 0.4 ||
        Math.abs(prev.rPeak - next.rPeak) > 0.4 ||
        Math.abs(prev.lRms - next.lRms) > 0.6 ||
        Math.abs(prev.rRms - next.rRms) > 0.6 ||
        Math.abs(prev.hold - next.hold) > 0.4 ||
        prev.clip !== next.clip;
      if (changed) {
        lastStateRef.current = next;
        setState(next);
      }
    });
    return () => unregisterRaf("master-mini-meter");
  }, [services]);

  // −60..0 dB maps to 0..100% — the readable floor for a 20px bar.
  const pos = (db: number) => `${Math.min(100, Math.max(0, (1 + db / 60) * 100))}%`;
  const hold = Math.min(100, Math.max(0, (1 + state.hold / 60) * 100));
  return (
    <>
      <button
        type="button"
        className="statusbar-io"
        onClick={onOpenAudioSettings}
        aria-label="Studio I/O — audio device settings"
        aria-describedby={meterDescriptionId}
        aria-expanded={audioSettingsOpen}
        title={`Studio I/O — output / input devices, ASIO drivers · Master out — L ${state.lPeak.toFixed(1)} dB · R ${state.rPeak.toFixed(1)} dB · hold ${state.hold.toFixed(1)} dB`}
      >
        <span className="statusbar-meter" aria-hidden="true">
          <span className={`statusbar-meter-bar${state.clip ? " clipping" : ""}`}>
            <i className="statusbar-meter-rms" style={{ height: pos(state.lRms) }} />
            <i className="statusbar-meter-fill" style={{ height: pos(state.lPeak) }} />
            {hold > 1 && <i className="statusbar-meter-hold" style={{ bottom: `${hold}%` }} />}
          </span>
          <span className={`statusbar-meter-bar${state.clip ? " clipping" : ""}`}>
            <i className="statusbar-meter-rms" style={{ height: pos(state.rRms) }} />
            <i className="statusbar-meter-fill" style={{ height: pos(state.rPeak) }} />
            {hold > 1 && <i className="statusbar-meter-hold" style={{ bottom: `${hold}%` }} />}
          </span>
        </span>
      </button>
      <span id={meterDescriptionId} className="sr-only">
        {`Master output level: left ${state.lPeak.toFixed(1)} dB peak, right ${state.rPeak.toFixed(1)} dB peak, hold ${state.hold.toFixed(1)} dB${state.clip ? ". Clipping hold active." : "."}`}
      </span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state.clip ? "Master output clipping." : ""}
      </span>
    </>
  );
}
