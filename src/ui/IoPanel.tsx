import { useEffect, useState } from "react";
import { useServices } from "./context";
import { PanelHeader } from "./PanelChrome";
import { EmptyState } from "./PanelChrome";
import {
  applyOutputDevice,
  listOutputDevices,
  loadOutputDeviceId,
  saveOutputDeviceId,
  setSinkIdSupported,
  type OutputDevice,
} from "../audio-engine/outputDevice";
import {
  listRecordingInputDevices,
  loadRecordingInputDeviceId,
  loadRecordingInputGainDb,
  saveRecordingInputDeviceId,
  saveRecordingInputGainDb,
  type RecordingInputDevice,
} from "../audio-engine/recordingInput";
import { clampInputGainDb } from "../audio-engine/PcmMicRecorder";
import { isLiveAudioContext } from "../audio-engine/liveContext";

/**
 * Studio I/O panel (ADR 0017/0018 surfaces) — output device, input device
 * and, on the desktop shell, ASIO driver discovery. The panel only ever
 * READS capabilities and reports them honestly: no ASIO streaming switch
 * (real-hardware streaming is an owner gate, ADR 0017's matrix), no silent
 * fallbacks — a blocked permission or an unsupported setSinkId is a message,
 * not an empty list.
 */

interface AsioDriverDetail {
  name?: string;
  inputChannels?: number;
  outputChannels?: number;
  bufferSize?: { min?: number; max?: number; preferred?: number };
  sampleRate?: number | string;
  [key: string]: unknown;
}

interface AsioListResult {
  registry: { status: string; names?: string[]; message?: string };
  details: { status: string; drivers?: AsioDriverDetail[]; partial?: boolean; message?: string };
}

type DesktopBridge = {
  asio?: { list: () => Promise<AsioListResult> };
};

function asioBridge(): DesktopBridge["asio"] | null {
  return (typeof window !== "undefined" ? (window as { kyxDesktop?: DesktopBridge }).kyxDesktop?.asio : null) ?? null;
}

function formatHz(rate: number | string | undefined): string {
  if (rate === undefined) return "—";
  const num = Number(rate);
  if (!Number.isFinite(num) || num <= 0) return String(rate);
  return num % 1000 === 0 ? `${num / 1000} kHz` : `${num} Hz`;
}

export function IoPanel() {
  const services = useServices();
  const engine = services.engine;

  // Context identity in state: setSinkId/device pickers need the LIVE
  // context, and the engine swaps contexts (device lifecycle) behind the
  // same facade — the panel must re-read, not cache, after each swap.
  const [ctx, setCtx] = useState<BaseAudioContext | null>(engine.context);
  useEffect(() => {
    const tick = () => setCtx((prev) => (prev === engine.context ? prev : engine.context));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [engine]);

  const liveCtx = ctx && isLiveAudioContext(ctx) ? ctx : null;
  const sinkSupported = setSinkIdSupported(liveCtx);

  // ----- OUTPUT -----
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [outputId, setOutputId] = useState<string>(loadOutputDeviceId() || "default");
  const [outputMessage, setOutputMessage] = useState<string | null>(null);
  const [outputsMissingLabels, setOutputsMissingLabels] = useState(false);

  const refreshOutputs = () => {
    void listOutputDevices().then((devices) => {
      setOutputs(devices);
      // Labels stay empty until the user has played audio in this browser
      // (Chromium's OutputDeviceInfo rule) — say so instead of "Audio output 1".
      setOutputsMissingLabels(devices.filter((d) => d.deviceId !== "default").every((d) => !d.label));
    });
  };
  useEffect(() => {
    refreshOutputs();
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    media?.addEventListener?.("devicechange", refreshOutputs);
    return () => media?.removeEventListener?.("devicechange", refreshOutputs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeOutput = (deviceId: string) => {
    setOutputId(deviceId);
    saveOutputDeviceId(deviceId === "default" ? "" : deviceId);
    void applyOutputDevice(liveCtx, deviceId === "default" ? "" : deviceId).then((result) => {
      setOutputMessage(result.status === "ok" ? null : (result.message ?? null));
    });
  };

  // ----- INPUT -----
  const [inputs, setInputs] = useState<RecordingInputDevice[]>([]);
  const [inputId, setInputId] = useState<string>(loadRecordingInputDeviceId());
  const [inputGainDb, setInputGainDb] = useState<number>(loadRecordingInputGainDb());
  const [inputsMissingLabels, setInputsMissingLabels] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listRecordingInputDevices().then((devices) => {
      if (cancelled) return;
      setInputs(devices);
      setInputsMissingLabels(devices.every((d) => !d.label || d.label.startsWith("Audio input ")));
    });
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    const onChange = () => void listRecordingInputDevices().then((devices) => !cancelled && setInputs(devices));
    media?.addEventListener?.("devicechange", onChange);
    return () => {
      cancelled = true;
      media?.removeEventListener?.("devicechange", onChange);
    };
  }, []);

  const changeInput = (deviceId: string) => {
    setInputId(deviceId);
    saveRecordingInputDeviceId(deviceId);
  };
  const changeInputGain = (db: number) => {
    const clamped = clampInputGainDb(db);
    setInputGainDb(clamped);
    saveRecordingInputGainDb(clamped);
  };

  // ----- ASIO (desktop only) -----
  const bridge = asioBridge();
  const [asio, setAsio] = useState<AsioListResult | null>(null);
  const [asioState, setAsioState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [asioError, setAsioError] = useState<string | null>(null);
  const loadAsio = () => {
    if (!bridge) return;
    setAsioState("loading");
    bridge
      .list()
      .then((result) => {
        setAsio(result);
        setAsioState("done");
      })
      .catch((err: unknown) => {
        setAsioError(err instanceof Error ? err.message : String(err));
        setAsioState("error");
      });
  };
  useEffect(() => {
    if (bridge && asioState === "idle") loadAsio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detailsByName = new Map<string, AsioDriverDetail>();
  for (const driver of asio?.details.drivers ?? []) {
    if (typeof driver.name === "string") detailsByName.set(driver.name, driver);
  }

  const tone = () => {
    const result = engine.playTestTone();
    if (result.status === "error") setOutputMessage(result.message ?? null);
  };

  return (
    <div className="io-panel" aria-label="Studio I/O">
      <PanelHeader kicker="STUDIO I/O" title="Audio devices" hint="Per-browser prefs" />

      {/* OUTPUT */}
      <section className="panel-section">
        <div className="panel-section-head">
          <span className="panel-section-title">OUTPUT</span>
          {liveCtx && (
            <span className="io-readout" data-hint="Active audio context" data-hint-value={liveCtx.state}>
              {liveCtx.state}
            </span>
          )}
        </div>
        <label className="io-field">
          <span className="io-field-label">DEVICE</span>
          <select
            value={outputId}
            onChange={(event) => changeOutput(event.target.value)}
            disabled={outputs.length <= 1}
          >
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Audio output ${device.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </label>
        {!sinkSupported && (
          <div className="io-note" role="note">
            This browser cannot switch outputs (no setSinkId) — sound follows the system default.
          </div>
        )}
        {outputsMissingLabels && sinkSupported && (
          <div className="io-note" role="note">
            Device names appear after the first playback in this session (browser privacy rule).
          </div>
        )}
        {outputMessage && (
          <div className="io-error" role="status">
            {outputMessage}
          </div>
        )}
        {liveCtx && (
          <div className="io-stats">
            <span data-hint="Context sample rate" data-hint-value={`${liveCtx.sampleRate} Hz`}>
              {liveCtx.sampleRate} Hz
            </span>
            <span
              data-hint="Base latency (lower = tighter)"
              data-hint-value={`${Math.round((liveCtx.baseLatency ?? 0) * 1000)} ms`}
            >
              base {(1000 * (liveCtx.baseLatency ?? 0)).toFixed(1)} ms
            </span>
            {liveCtx.outputLatency !== undefined && (
              <span
                data-hint="Reported output latency"
                data-hint-value={`${Math.round(liveCtx.outputLatency * 1000)} ms`}
              >
                out {(1000 * liveCtx.outputLatency).toFixed(1)} ms
              </span>
            )}
          </div>
        )}
        <div className="io-actions">
          <button type="button" className="btn btn-small" onClick={tone} disabled={!liveCtx}>
            TEST TONE
          </button>
        </div>
      </section>

      {/* INPUT */}
      <section className="panel-section">
        <div className="panel-section-head">
          <span className="panel-section-title">INPUT</span>
        </div>
        <label className="io-field">
          <span className="io-field-label">DEVICE</span>
          <select value={inputId} onChange={(event) => changeInput(event.target.value)}>
            <option value="">System default input</option>
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
        {inputsMissingLabels && inputs.length > 0 && (
          <div className="io-note" role="note">
            Microphone names appear after granting input permission (arm a recording once).
          </div>
        )}
        <label className="io-field io-field-slider">
          <span className="io-field-label">TRIM</span>
          <input
            type="range"
            min={-24}
            max={24}
            step={0.5}
            value={inputGainDb}
            data-hint="Input trim — pre-gain for every recording take"
            data-hint-value={`${inputGainDb > 0 ? "+" : ""}${inputGainDb.toFixed(1)} dB`}
            onChange={(event) => changeInputGain(Number(event.target.value))}
          />
          <span className="io-field-value">
            {inputGainDb > 0 ? "+" : ""}
            {inputGainDb.toFixed(1)} dB
          </span>
        </label>
        <div className="io-note" role="note">
          Applies to audio-input takes; the arrangement recording toolbar picks the same device.
        </div>
      </section>

      {/* DRIVERS — desktop shell only */}
      {bridge && (
        <section className="panel-section">
          <div className="panel-section-head">
            <span className="panel-section-title">ASIO DRIVERS</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={loadAsio}
              disabled={asioState === "loading"}
              title="Re-run discovery (registry + out-of-process probe)"
            >
              {asioState === "loading" ? "SCANNING…" : "RESCAN"}
            </button>
          </div>
          {asioState === "error" && (
            <div className="io-error" role="status">
              Discovery failed: {asioError}
            </div>
          )}
          {asio?.registry.status === "ok" && (asio.registry.names?.length ?? 0) === 0 && (
            <EmptyState icon="🎛" title="No ASIO drivers registered" hint="Install a driver (or FlexASIO) and rescan." />
          )}
          {(asio?.registry.names?.length ?? 0) > 0 && (
            <ul className="io-driver-list">
              {asio!.registry.names!.map((name) => {
                const detail = detailsByName.get(name);
                return (
                  <li key={name} className="io-driver">
                    <span className="io-driver-name" title={name}>
                      {name}
                    </span>
                    <span className="io-driver-meta">
                      {detail
                        ? [
                            detail.inputChannels !== undefined ? `${detail.inputChannels}in` : null,
                            detail.outputChannels !== undefined ? `${detail.outputChannels}out` : null,
                            detail.bufferSize?.min !== undefined
                              ? `${detail.bufferSize.min}–${detail.bufferSize.max ?? "?"} smp`
                              : null,
                            detail.sampleRate !== undefined ? formatHz(detail.sampleRate) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "registered — details unavailable"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {asio && asio.details.status !== "ok" && (asio.registry.names?.length ?? 0) > 0 && (
            <div className="io-note" role="note">
              {asio.details.status === "no-probe"
                ? "Detailed probe not built on this machine — registry names only."
                : asio.details.partial
                  ? "Some drivers did not answer before the timeout — partial results shown."
                  : `Probe status: ${asio.details.status}`}
            </div>
          )}
          <div className="io-note" role="note">
            Discovery only (ADR 0017). Streaming from real hardware stays an owner gate — the playback pipeline itself
            is soak-tested (ADR 0018).
          </div>
        </section>
      )}
    </div>
  );
}
