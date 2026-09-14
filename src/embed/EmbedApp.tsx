import { useCallback, useEffect, useRef, useState } from "react";
import { renderProject } from "../rendering/renderer";
import { decodeShareCode, shareAppUrl } from "../export/shareCode";

type Phase = { kind: "decoding" } | { kind: "rendering" } | { kind: "ready" } | { kind: "error"; message: string };

/**
 * /embed — a self-contained beat player for sharing.
 *
 * The whole project travels in the URL hash (#p=<share code>); this page
 * decodes it, renders it deterministically with the exact offline engine
 * (instruments, effects, groove — no playback compromise), and exposes a
 * minimal play/seek chrome plus an "Open in KYX" CTA that drops the
 * same project straight into the full studio (?import=…).
 *
 * No app services are booted — no IndexedDB, no scheduler, no MIDI. The
 * embed is intentionally as small as a share page can be.
 */
export function EmbedApp({
  code: codeProp,
  inline = false,
  hideBrand = false,
}: { code?: string; inline?: boolean; hideBrand?: boolean } = {}) {
  const [phase, setPhase] = useState<Phase>({ kind: "decoding" });
  const [meta, setMeta] = useState<{ name: string; bpm: number; code: string } | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const playingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(0);

  // ── decode + render ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const code =
      codeProp ??
      new URLSearchParams(
        typeof location !== "undefined" && location.hash.startsWith("#") ? location.hash.slice(1) : "",
      ).get("p");
    if (!code) {
      setPhase({ kind: "error", message: "Missing beat code in the link." });
      return;
    }
    const doc = decodeShareCode(code);
    if (!doc) {
      setPhase({ kind: "error", message: "This beat link is invalid or corrupted." });
      return;
    }
    if (cancelled) return;
    setMeta({ name: doc.name, bpm: doc.bpm, code });
    setPhase({ kind: "rendering" });
    void (async () => {
      try {
        const { generateFactoryBank } = await import("../sample-library/factory");
        const bank = await generateFactoryBank();
        // The user sample bank is local to the creator's browser — freeze
        // handles those tracks; anything missing simply renders silently.
        const buffer = await renderProject(doc, bank, { mode: "song", sampleRate: 44100 });
        if (cancelled) return;
        bufferRef.current = buffer;
        drawWaveform(buffer);
        setPhase({ kind: "ready" });
      } catch (error) {
        if (!cancelled) setPhase({ kind: "error", message: `Render failed: ${String(error)}` });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── playback ────────────────────────────────────────────────────────────
  const stopSource = useCallback(() => {
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
  }, []);

  const play = useCallback(() => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    // Defect A06.D1 (browser compatibility hardening): feature-detect
    // AudioContext before constructing it. Server-side render, an
    // iframe sandbox without `allow-scripts`/`allow-same-origin`, or
    // any future webview that omits the audio context global would
    // otherwise throw a ReferenceError mid-click. Surface a clear
    // "audio not supported" state instead of a stack trace.
    if (typeof AudioContext === "undefined") {
      setPlaying(false);
      setPhase({ kind: "error", message: "This browser does not expose AudioContext — preview is disabled." });
      return;
    }
    ctxRef.current ??= new AudioContext();
    const ctx = ctxRef.current;
    void ctx.resume().catch(() => {});
    stopSource();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const offset = Math.min(offsetRef.current, buffer.duration - 0.05);
    source.start(0, Math.max(0, offset));
    startedAtRef.current = ctx.currentTime - offset;
    sourceRef.current = source;
    playingRef.current = true;
    setPlaying(true);
  }, [stopSource]);

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) return;
    offsetRef.current = Math.min(ctx.currentTime - startedAtRef.current, bufferRef.current?.duration ?? 0);
    stopSource();
    playingRef.current = false;
    setPlaying(false);
  }, [stopSource]);

  const seek = useCallback(
    (fraction: number) => {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const clamped = Math.max(0, Math.min(0.999, fraction));
      const wasPlaying = playingRef.current;
      offsetRef.current = clamped * buffer.duration;
      setProgress(clamped);
      if (wasPlaying) play();
    },
    [play],
  );

  // Progress loop while playing.
  useEffect(() => {
    const tick = () => {
      const ctx = ctxRef.current;
      const buffer = bufferRef.current;
      if (ctx && buffer && playingRef.current) {
        const t = ctx.currentTime - startedAtRef.current;
        setProgress(Math.min(1, t / buffer.duration));
        if (t >= buffer.duration) {
          playingRef.current = false;
          offsetRef.current = 0;
          setPlaying(false);
          setProgress(0);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    return () => {
      stopSource();
      void ctxRef.current?.close().catch(() => {});
    };
  }, [stopSource]);

  // ── waveform ────────────────────────────────────────────────────────────
  const drawWaveform = (buffer: AudioBuffer) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const w = (canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1));
    const h = (canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1));
    const data = buffer.getChannelData(0);
    const columns = Math.max(24, Math.floor(w / 5));
    const per = Math.floor(data.length / columns);
    ctx2d.clearRect(0, 0, w, h);
    for (let c = 0; c < columns; c++) {
      let min = 1;
      let max = -1;
      for (let i = c * per; i < (c + 1) * per && i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
      }
      const amp = Math.max(0.02, (max - min) / 2);
      const barH = amp * h * 0.86;
      ctx2d.fillStyle = "#3f3f46";
      ctx2d.fillRect(c * (w / columns) + 1, h / 2 - barH / 2, Math.max(2, w / columns - 2), barH);
    }
    canvas.dataset.ready = "1";
  };

  const openUrl = meta
    ? shareAppUrl(meta.code, typeof location !== "undefined" ? location.origin : "https://kyx.app")
    : "#";
  const duration = bufferRef.current?.duration ?? 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className={"embed-root" + (inline ? " embed-inline" : "")} role="document" aria-label="KYX beat player">
      <div className="embed-main">
        <button
          type="button"
          className="embed-play"
          disabled={phase.kind !== "ready"}
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => (playing ? pause() : play())}
        >
          {phase.kind === "ready" ? (playing ? "❚❚" : "▶") : phase.kind === "rendering" ? "…" : "!"}
        </button>
        <div
          className="embed-wave"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - rect.left) / rect.width);
          }}
        >
          <canvas ref={canvasRef} className="embed-canvas" />
          {/* A zero-width progress bar would still paint its 2px right border
              before the first play — only mount it once playback started. */}
          {progress > 0 && <div className="embed-progress" style={{ width: `${progress * 100}%` }} />}
        </div>
        <span className="embed-time">
          {fmt(progress * duration)} / {fmt(duration)}
        </span>
      </div>
      <div className="embed-footer">
        <span className="embed-meta">{meta ? `${meta.name} · ${Math.round(meta.bpm)} BPM` : "…"}</span>
        <span className="embed-status" data-phase={phase.kind}>
          {phase.kind === "rendering" ? "rendering…" : ""}
          {phase.kind === "error" ? phase.message : ""}
        </span>
        <div className="embed-actions">
          <a className="embed-cta" href={openUrl} target="_blank" rel="noreferrer">
            OPEN IN KYX
          </a>
          {!hideBrand && (
            <span className="embed-brand">
              <span className="embed-brand-mark">KX</span> KYX
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
