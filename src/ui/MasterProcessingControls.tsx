import { setMasterConfig } from "../commands/commands";
import type { MasterConfig } from "../project-model/types";
import { Slider } from "./controls";
import { useMaster, useServices } from "./context";

type MasterProcessingView = "simple" | "advanced" | "advanced-extras";

interface MasterProcessingControlsProps {
  view?: MasterProcessingView;
  /** Supply a session config to edit an isolated master without touching the active project. */
  config?: MasterConfig;
  onChange?: (patch: Partial<MasterConfig>) => void;
  disabled?: boolean;
}

/** Shared built-in master controls for the project master and isolated mastering sessions. */
export function MasterProcessingControls({
  view = "advanced",
  config,
  onChange,
  disabled = false,
}: MasterProcessingControlsProps) {
  const services = useServices();
  const projectMaster = useMaster();
  const master = config ?? projectMaster;
  const advanced = view !== "simple";
  const showPrimaryControls = view !== "advanced-extras";
  const commit = (patch: Parameters<typeof setMasterConfig>[1]) => {
    if (disabled) return;
    if (onChange) {
      onChange(patch);
      return;
    }
    if (config) return;
    services.store.execute(setMasterConfig(services.store.getDoc(), patch));
  };
  const gainDbLabel = (value: number): string => {
    const db = 20 * Math.log10(Math.max(value, 0.001));
    return `${db <= -59 ? "-INF" : db.toFixed(1)} dB`;
  };

  return (
    <div
      className="master-processing-controls"
      data-view={view}
      role="group"
      aria-label={onChange ? "Isolated master processing controls" : "Built-in master processing controls"}
    >
      {showPrimaryControls && (
        <div className="master-core-control-bank">
          <Slider
            compact
            label="IN"
            hint="Master input gain — drives the master tone and dynamics stages. Reference matching uses a separate audition trim."
            value={master.masterGain}
            min={0}
            max={2}
            defaultValue={1}
            format={gainDbLabel}
            disabled={disabled}
            onCommit={(masterGain) => commit({ masterGain })}
            onPreview={onChange ? undefined : (masterGain) => services.engine.previewMasterGain(masterGain)}
            onCancel={onChange ? undefined : () => services.engine.previewMasterGain(master.masterGain)}
          />
          <Slider
            compact
            label="CEIL"
            hint="Requested output ceiling in dBFS. The look-ahead worklet uses a 0.2 dB reserve, then applies an output-side true-peak correction with 32 samples of added latency. Studio HQ adds 64 samples when its 2× FIR limiter oversampling is active; both delays are included in PDC. Confirm exported dBTP in the delivery report. The native fallback cannot guarantee inter-sample peaks and is marked Degraded."
            value={master.ceilingDb}
            min={-12}
            max={0}
            defaultValue={-1}
            format={(value) => `${value.toFixed(1)} dB`}
            disabled={disabled}
            onCommit={(ceilingDb) => commit({ ceilingDb })}
          />
          <Slider
            compact
            label="TRIM"
            hint="Gain before the limiter. More trim can increase limiting; compare at matched audition loudness."
            value={master.loudnessTrimDb ?? 0}
            min={-6}
            max={6}
            defaultValue={0}
            format={(value) => (value === 0 ? "0 dB" : `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`)}
            disabled={disabled}
            onCommit={(loudnessTrimDb) => commit({ loudnessTrimDb: Math.round(loudnessTrimDb * 10) / 10 })}
          />
          {advanced && (
            <Slider
              compact
              label="TILT"
              hint="Complementary low/high shelves. Use small changes and compare at matched loudness."
              value={master.tiltDb ?? 0}
              min={-4}
              max={4}
              defaultValue={0}
              format={(value) => (value === 0 ? "0 dB" : `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`)}
              disabled={disabled}
              onCommit={(tiltDb) => commit({ tiltDb: Math.round(tiltDb * 2) / 2 })}
            />
          )}
        </div>
      )}

      {advanced && (
        <div className="master-core-control-bank">
          <label className="generate-field generate-label">
            LIMITER CHARACTER
            <select
              className="generate-select"
              aria-label="Limiter character"
              aria-description="Transparent preserves the previous limiter response. Punch recovers faster; Smooth uses a wider knee and slower recovery. Compare at matched loudness."
              value={master.limiterCharacter ?? "transparent"}
              disabled={disabled}
              onChange={(event) =>
                commit({ limiterCharacter: event.target.value as NonNullable<MasterConfig["limiterCharacter"]> })
              }
              title="Transparent preserves the original limiter response. Punch recovers faster; Smooth uses a wider knee and slower recovery. Compare at matched loudness."
            >
              <option value="transparent">Transparent</option>
              <option value="punch">Punch</option>
              <option value="smooth">Smooth</option>
            </select>
          </label>
          <Slider
            compact
            label="LOOK"
            hint="How far ahead the master limiter sees peaks. More look-ahead can catch fast transients but softens attacks and delays the whole master output; all tracks share this stage."
            value={master.limiterLookaheadMs ?? 5}
            min={1}
            max={20}
            defaultValue={5}
            format={(value) => `${value.toFixed(1)} ms`}
            taper="log"
            disabled={disabled}
            onCommit={(limiterLookaheadMs) => commit({ limiterLookaheadMs: Math.round(limiterLookaheadMs * 10) / 10 })}
          />
          <Slider
            compact
            label="REL"
            hint="Base recovery time after gain reduction; deeper limiting recovers more slowly. Faster recovery can increase loudness but may pump, while slower recovery can hold gain reduction longer. Compare at matched loudness."
            value={master.limiterReleaseMs ?? 120}
            min={10}
            max={2000}
            defaultValue={120}
            format={(value) => `${Math.round(value)} ms`}
            taper="log"
            disabled={disabled}
            onCommit={(limiterReleaseMs) => commit({ limiterReleaseMs: Math.round(limiterReleaseMs) })}
          />
          <Slider
            compact
            label="TRANS LINK"
            hint="Links limiter gain reduction across left and right while cutting a transient. 100% keeps the channels together; lower values let each channel limit more independently and may shift the stereo image. The native limiter fallback does not support channel-link controls and is marked Degraded. Start at 100% and compare at matched loudness."
            value={(master.limiterTransientLink ?? 1) * 100}
            min={0}
            max={100}
            defaultValue={100}
            format={(value) => `${Math.round(value)}%`}
            disabled={disabled}
            onCommit={(limiterTransientLink) =>
              commit({ limiterTransientLink: Math.round(limiterTransientLink) / 100 })
            }
          />
          <Slider
            compact
            label="REL LINK"
            hint="Links limiter gain recovery across left and right after a transient. 100% recovers together; lower values let each channel recover more independently and may shift the stereo image. The output true-peak safety correction remains linked. The native limiter fallback does not support channel-link controls and is marked Degraded."
            value={(master.limiterReleaseLink ?? 1) * 100}
            min={0}
            max={100}
            defaultValue={100}
            format={(value) => `${Math.round(value)}%`}
            disabled={disabled}
            onCommit={(limiterReleaseLink) => commit({ limiterReleaseLink: Math.round(limiterReleaseLink) / 100 })}
          />
        </div>
      )}

      <div className="master-core-control-bank">
        <div className="master-toggles" role="group" aria-label="Master processor switches">
          {showPrimaryControls && (
            <button
              type="button"
              className={`btn btn-small${master.limiterEnabled ? " active-solo" : ""}`}
              title="Look-ahead limiter safety stage. Keep enabled for a controlled output ceiling."
              aria-label="Master limiter"
              aria-pressed={master.limiterEnabled}
              disabled={disabled}
              onClick={() => commit({ limiterEnabled: !master.limiterEnabled })}
            >
              LIMIT
            </button>
          )}
          {advanced && (
            <>
              {showPrimaryControls && (
                <>
                  <button
                    type="button"
                    className={`btn btn-small${master.clipperEnabled ? " active-solo" : ""}`}
                    title="Soft clipper adds saturation above its ceiling."
                    aria-label="Master soft clipper"
                    aria-pressed={master.clipperEnabled}
                    disabled={disabled}
                    onClick={() => commit({ clipperEnabled: !master.clipperEnabled })}
                  >
                    CLIP
                  </button>
                  <button
                    type="button"
                    className={`btn btn-small${(master.glueEnabled ?? true) ? " active-solo" : ""}`}
                    title="Gentle bus compression before the master inserts."
                    aria-label="Master glue"
                    aria-pressed={master.glueEnabled ?? true}
                    disabled={disabled}
                    onClick={() => commit({ glueEnabled: !(master.glueEnabled ?? true) })}
                  >
                    GLUE
                  </button>
                </>
              )}
              <button
                type="button"
                className={`btn btn-small${master.tapeEnabled ? " active-solo" : ""}`}
                title="Tape saturation on the master bus."
                aria-label="Master tape"
                aria-pressed={!!master.tapeEnabled}
                disabled={disabled}
                onClick={() => commit({ tapeEnabled: !master.tapeEnabled })}
              >
                TAPE
              </button>
              <button
                type="button"
                className={`btn btn-small${master.msEnabled ? " active-solo" : ""}`}
                title="Enable mid/side gain controls. Start at unity and use subtle changes."
                aria-label="Master mid side"
                aria-pressed={!!master.msEnabled}
                disabled={disabled}
                onClick={() => commit({ msEnabled: !master.msEnabled })}
              >
                M/S
              </button>
              <button
                type="button"
                className={`btn btn-small${master.bassMonoEnabled ? " active-solo" : ""}`}
                title="Fold the low-frequency side signal toward mono below the selected frequency."
                aria-label="Master bass mono"
                aria-pressed={!!master.bassMonoEnabled}
                disabled={disabled}
                onClick={() => commit({ bassMonoEnabled: !master.bassMonoEnabled })}
              >
                B-MONO
              </button>
            </>
          )}
        </div>

        {advanced && master.tapeEnabled && (
          <Slider
            compact
            label="TAPE DRIVE"
            disabled={disabled}
            value={master.tapeDrive ?? 0.35}
            min={0}
            max={1}
            defaultValue={0.35}
            format={(value) => `${Math.round(value * 100)}%`}
            onCommit={(tapeDrive) => commit({ tapeDrive })}
          />
        )}
        {advanced && master.msEnabled && (
          <div className="master-core-pair">
            <Slider
              compact
              label="MID"
              disabled={disabled}
              value={master.msMidGain ?? 0}
              min={-6}
              max={6}
              defaultValue={0}
              format={(value) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`}
              onCommit={(msMidGain) => commit({ msMidGain })}
            />
            <Slider
              compact
              label="SIDE"
              disabled={disabled}
              value={master.msSideGain ?? 0}
              min={-6}
              max={6}
              defaultValue={0}
              format={(value) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`}
              onCommit={(msSideGain) => commit({ msSideGain })}
            />
          </div>
        )}
        {advanced && master.bassMonoEnabled && (
          <Slider
            compact
            label="B-MONO"
            disabled={disabled}
            value={master.bassMonoFreq ?? 120}
            min={60}
            max={400}
            defaultValue={120}
            format={(value) => `${Math.round(value)} Hz`}
            onCommit={(bassMonoFreq) => commit({ bassMonoFreq })}
          />
        )}
      </div>
    </div>
  );
}
