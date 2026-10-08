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
            hint="Physical limiter ceiling in dBFS. The look-ahead worklet keeps a 0.2 dB reserve below it; the native fallback cannot guarantee inter-sample peaks and is marked Degraded. Delivery profile true-peak targets are checked separately."
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
