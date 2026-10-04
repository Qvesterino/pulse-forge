import { useEffect, useRef, useState } from "react";
import { clearMixPreviewLane, currentMixPreviewLane, onMixPreviewLane, type MixPreviewLane } from "../mcp/mix-preview";
import { useServices } from "./context";

type Side = "before" | "after";

export function MixPreviewChipLazy() {
  const services = useServices();
  const [lane, setLane] = useState<MixPreviewLane | null>(currentMixPreviewLane());
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
          const rendered = await renderProject(doc, services.bank, { mode, sampleRate: 44100, tailSeconds: 0.6 });
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
      source.start();
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

  if (!lane) return null;

  return (
    <div className="mix-preview-card" role="dialog" aria-label="Mix idea preview">
      <div className="mix-preview-head">
        <span className="mix-preview-title">MIX PREVIEW</span>
        <span className="mix-preview-label">{lane.label}</span>
        <button
          type="button"
          className="mix-preview-x"
          aria-label="Dismiss preview"
          onClick={() => {
            stopPlayback();
            clearMixPreviewLane();
          }}
        >
          ✕
        </button>
      </div>
      <span className="mix-preview-stats">
        before {lane.stats.beforeLufs != null ? `${lane.stats.beforeLufs.toFixed(1)}` : "n/a"} · after{" "}
        {lane.stats.afterLufs != null ? `${lane.stats.afterLufs.toFixed(1)}` : "n/a"} LUFS-I
        {lane.stats.matchGainDb !== 0 &&
          ` · after level-matched ${lane.stats.matchGainDb > 0 ? "+" : ""}${lane.stats.matchGainDb.toFixed(1)} dB`}
      </span>
      <div className="mix-preview-actions">
        {(["before", "after"] as const).map((side) => (
          <button
            key={side}
            type="button"
            className="btn btn-export mix-preview-play"
            disabled={rendering != null}
            onClick={() => void play(side)}
          >
            {rendering === side ? "rendering…" : playingSide === side ? "■ STOP" : `▶ ${side.toUpperCase()}`}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-export mix-preview-apply"
          disabled={rendering != null}
          onClick={() => {
            stopPlayback();
            services.store.execute(lane.command);
            clearMixPreviewLane();
          }}
        >
          APPLY
        </button>
      </div>
      {error && <span className="mix-preview-error">{error}</span>}
    </div>
  );
}
