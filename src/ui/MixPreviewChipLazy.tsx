import { useEffect, useRef, useState } from "react";
import {
  clearMixPreviewLane,
  currentMixPreviewLane,
  applyAndVerifyMixPreview,
  mixPreviewMatchesProject,
  onMixPreviewLane,
  type MixPreviewLane,
  type MixPreviewVerification,
} from "../mcp/mix-preview";
import { storeRevision } from "../mcp/revision";
import { useServices } from "./context";

type Side = "before" | "after";

export function MixPreviewChipLazy() {
  const services = useServices();
  const [lane, setLane] = useState<MixPreviewLane | null>(currentMixPreviewLane());
  const [appliedLane, setAppliedLane] = useState<MixPreviewLane | null>(null);
  const [verification, setVerification] = useState<MixPreviewVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [rendering, setRendering] = useState<Side | null>(null);
  const [playingSide, setPlayingSide] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buffersRef = useRef<{ before?: AudioBuffer; after?: AudioBuffer }>({});
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  useEffect(
    () =>
      onMixPreviewLane((next) => {
        // A fresh lane invalidates any cached render of the previous one.
        buffersRef.current = {};
        stopPlayback();
        setPlayingSide(null);
        setError(null);
        if (next !== null) {
          setAppliedLane(null);
          setVerification(null);
        }
        setLane(next);
      }),
    [],
  );

  function stopPlayback() {
    const source = sourceRef.current;
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
      sourceRef.current = null;
    }
  }

  async function play(side: Side) {
    if (!lane || rendering) return;
    setError(null);
    if (playingSide === side) {
      stopPlayback();
      setPlayingSide(null);
      return;
    }
    stopPlayback();
    setRendering(side);
    try {
      const buffers = buffersRef.current;
      if (typeof AudioContext === "undefined") throw new Error("this browser has no AudioContext");
      const cached = side === "before" ? buffers.before : buffers.after;
      const buffer =
        cached ??
        (await (async () => {
          const { renderProject } = await import("../rendering/renderer");
          const doc = side === "before" ? lane.beforeDoc : lane.afterDoc;
          const mode = doc.arrangement.clips.length > 0 ? ("song" as const) : ("pattern" as const);
          const rendered = await renderProject(doc, services.bank, {
            mode,
            sampleRate: 44100,
            tailSeconds: 0.6,
            ...(lane.window ? { minimumDurationTicks: lane.window.endTick, arrangementOnly: true } : {}),
          });
          if (side === "before") buffers.before = rendered;
          else buffers.after = rendered;
          return rendered;
        })());
      ctxRef.current ??= new AudioContext();
      const ctx = ctxRef.current;
      void ctx.resume().catch(() => {});
      gainRef.current ??= ctx.createGain();
      const gain = gainRef.current;
      gain.gain.cancelScheduledValues(ctx.currentTime);
      // Level-match: only the AFTER side rides the measured delta.
      gain.gain.setValueAtTime(side === "after" ? Math.pow(10, lane.stats.matchGainDb / 20) : 1, ctx.currentTime);
      gain.disconnect();
      gain.connect(ctx.destination);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      if (lane.window) source.start(ctx.currentTime, lane.window.startSec, lane.window.durationSec);
      else source.start();
      sourceRef.current = source;
      setPlayingSide(side);
      source.onended = () => {
        if (sourceRef.current === source) {
          sourceRef.current = null;
          setPlayingSide(null);
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlayingSide(null);
    } finally {
      setRendering(null);
    }
  }

  async function applyAndVerify() {
    if (!lane || verifying) return;
    stopPlayback();
    setError(null);
    const currentDoc = typeof services.store.getDoc === "function" ? services.store.getDoc() : null;
    const currentRevision = storeRevision(services.store);
    const revisionChanged =
      lane.revisionAfterRender != null && currentRevision != null && lane.revisionAfterRender !== currentRevision;
    if (revisionChanged || (currentDoc != null && !mixPreviewMatchesProject(lane, currentDoc, currentRevision))) {
      setError("Project changed after this preview. Dismiss it and run the preview again before applying.");
      return;
    }
    setAppliedLane(lane);
    setVerifying(true);
    try {
      const outcome = await applyAndVerifyMixPreview(services, lane);
      if (!outcome.applied) {
        setAppliedLane(null);
        setError("Project changed before Apply. Dismiss this preview and run it again.");
        return;
      }
      setVerification(outcome.verification ?? null);
    } catch (err) {
      setAppliedLane(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  const visibleLane = lane ?? appliedLane;
  if (!visibleLane && !verifying) return null;

  return (
    <div className="mix-preview-card" role="dialog" aria-label="Mix idea preview">
      <div className="mix-preview-head">
        <span className="mix-preview-title">{verification ? "POST-APPLY CHECK" : "MIX PREVIEW"}</span>
        <span className="mix-preview-label">{visibleLane?.label ?? "Mix idea"}</span>
        <button
          type="button"
          className="mix-preview-x"
          aria-label="Dismiss preview"
          disabled={verifying}
          onClick={() => {
            stopPlayback();
            clearMixPreviewLane();
            setAppliedLane(null);
            setVerification(null);
          }}
        >
          ✕
        </button>
      </div>
      {visibleLane && (
        <span className="mix-preview-stats">
          before {visibleLane.stats.beforeLufs != null ? `${visibleLane.stats.beforeLufs.toFixed(1)}` : "n/a"} · after{" "}
          {visibleLane.stats.afterLufs != null ? `${visibleLane.stats.afterLufs.toFixed(1)}` : "n/a"} LUFS-I
          {visibleLane.stats.matchGainDb !== 0 &&
            ` · after level-matched ${visibleLane.stats.matchGainDb > 0 ? "+" : ""}${visibleLane.stats.matchGainDb.toFixed(1)} dB`}
        </span>
      )}
      {visibleLane?.window && (
        <span className="mix-preview-range">
          range ticks {visibleLane.window.startTick}..{visibleLane.window.endTick} ·{" "}
          {visibleLane.window.durationSec.toFixed(2)} s · revision {visibleLane.projectRevision ?? "unknown"} →{" "}
          {visibleLane.revisionAfterRender ?? "unknown"} ({visibleLane.freshness ?? "unknown"})
        </span>
      )}
      {visibleLane && visibleLane.steps.length > 0 && (
        <ol className="mix-preview-changes" aria-label="Planned parameter changes">
          {visibleLane.steps.map((step, index) => (
            <li key={`${step.trackId}:${step.device}:${index}`}>
              <strong>{step.track}</strong> · {step.device}
              {step.changes.length > 0 ? (
                <ul>
                  {step.changes.map((change) => (
                    <li key={`${change.param}:${change.before ?? "unset"}:${change.after}`}>
                      {change.param}: {change.before === null ? "unset" : change.before} → {change.after}
                    </li>
                  ))}
                </ul>
              ) : (
                <span> · {step.params}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {visibleLane && visibleLane.warnings.length > 0 && (
        <ul className="mix-preview-warnings" aria-label="Preview caveats">
          {visibleLane.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {verification ? (
        <div className="mix-preview-stats" role="status">
          fresh render: {verification.status} · preview {formatLufs(verification.previewAfterLufs)} · measured after{" "}
          {formatLufs(verification.actualAfterLufs)} · Δ from before {formatDelta(verification.actualDeltaLufs)}
          {verification.differenceFromPreviewLufs !== null &&
            ` · measured−preview ${formatDelta(verification.differenceFromPreviewLufs)}`}
          {` · structure ${verification.structureMatchesPlan ? "matches plan" : "differs from plan"} · freshness ${verification.freshness}`}
          {verification.reason ? ` · ${verification.reason}` : ""}
        </div>
      ) : verifying ? (
        <div className="mix-preview-stats" role="status">
          Applied; rendering the same scope to verify the actual LUFS result…
        </div>
      ) : null}
      {lane && !verification && (
        <div className="mix-preview-actions">
          {(["before", "after"] as const).map((side) => (
            <button
              key={side}
              type="button"
              className="btn btn-export mix-preview-play"
              disabled={rendering != null || verifying}
              onClick={() => void play(side)}
            >
              {rendering === side ? "rendering…" : playingSide === side ? "■ STOP" : `▶ ${side.toUpperCase()}`}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-export mix-preview-apply"
            disabled={rendering != null || verifying}
            onClick={() => void applyAndVerify()}
          >
            {verifying ? "VERIFYING…" : "APPLY"}
          </button>
        </div>
      )}
      {error && <span className="mix-preview-error">{error}</span>}
    </div>
  );
}

function formatLufs(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} LUFS-I`;
}

function formatDelta(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(1)} LU`;
}
