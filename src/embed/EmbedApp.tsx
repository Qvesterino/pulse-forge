import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeShareCode, shareAppUrl } from "../export/shareCode";
import { intentSnapshotOfDoc } from "../gallery/intentCarry";
import { BRIGHT_LEVEL, DARK_LEVEL, applyEnergy, energyWeights, parseEmbedCommand } from "./energy";
import type { ProjectDocument } from "../project-model/types";

type Phase = { kind: "decoding" } | { kind: "rendering" } | { kind: "ready" } | { kind: "error"; message: string };
type Variants = "idle" | "rendering" | "ready" | "unavailable";

/** Anchor buffer slots: [0] dark · [1] authored · [2] bright. */
type VariantBuffers = [AudioBuffer | null, AudioBuffer | null, AudioBuffer | null];

/**
 * /embed — a self-contained beat player for sharing.
 *
 * The whole project travels in the URL hash (#p=<share code>); this page
 * decodes it, renders it deterministically with the exact offline engine
 * (instruments, effects, groove — no playback compromise), and exposes a
 * minimal play/seek chrome plus an "Open in KYX" CTA that drops the
 * same project straight into the full studio (?import=…).
 *
 * ENERGY (interactive beats): after the authored render completes, two more
 * offline passes render a dark and a bright variant (see ./energy). All
 * three play in sample-locked sync through per-variant gains, and the
 * energy slider equal-power crossfades between them — the listener rides
 * the beat from skeleton to drop without re-rendering anything. The same
 * control is exposed over postMessage (`kyx:*` commands) for games and OBS
 * overlays, plus arrow-key hotkeys for streamers. Both integrations are
 * disabled for inline usage (landing hero, gallery cards).
 *
 * No app services are booted — no IndexedDB, no scheduler, no MIDI. The
 * embed is intentionally as small as a share page can be.
 */
export function EmbedApp({
  code: codeProp,
  inline = false,
  hideBrand = false,
  onPlayed,
  exclusiveGroup,
}: {
  code?: string;
  inline?: boolean;
  hideBrand?: boolean;
  /** Fired when playback actually starts (autoplay-safe: always a user click). */
  onPlayed?: () => void;
  /**
   * Players sharing a group name never play simultaneously (gallery battles:
   * starting one side pauses the other). Registry is module-level — no React
   * coupling, no events, works across re-mounts.
   */
  exclusiveGroup?: string;
} = {}) {
  const [phase, setPhase] = useState<Phase>({ kind: "decoding" });
  const [meta, setMeta] = useState<{ name: string; bpm: number; code: string } | null>(null);
  /** The decoded project — kept for the B2 regenerable check and the energy variants (no re-decode). */
  const bufferDocRef = useRef<ProjectDocument | null>(null);
  const bankRef = useRef<Awaited<ReturnType<typeof import("../sample-library/factory").generateFactoryBank>> | null>(
    null,
  );
  const buffersRef = useRef<VariantBuffers>([null, null, null]);
  const ctxRef = useRef<AudioContext | null>(null);
  /** Per-variant gain chain — sources plug into these, weights ride here. */
  const gainsRef = useRef<[GainNode, GainNode, GainNode] | null>(null);
  const sourcesRef = useRef<Array<AudioBufferSourceNode | null>>([null, null, null]);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const playingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(0);
  const [variants, setVariants] = useState<Variants>("idle");
  const variantsRef = useRef<Variants>("idle");
  const [energy, setEnergy] = useState(0.5);
  const energyRef = useRef(0.5);
  const lastStatePostRef = useRef(0);
  const pauseRef = useRef<() => void>(() => {});

  const setVariantsState = useCallback((next: Variants) => {
    variantsRef.current = next;
    setVariants(next);
  }, []);

  /** Post playback state to the embedding page; throttled unless forced. */
  const postState = useCallback(
    (force: boolean) => {
      if (inline) return;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (!force && now - lastStatePostRef.current < 250) return;
      lastStatePostRef.current = now;
      const ctx = ctxRef.current;
      const buffer = buffersRef.current[1];
      const t = ctx && playingRef.current ? ctx.currentTime - startedAtRef.current : offsetRef.current;
      postToParent({
        type: "kyx:state",
        playing: playingRef.current,
        progress: buffer ? Math.min(1, Math.max(0, t / buffer.duration)) : 0,
        energy: energyRef.current,
        duration: buffer?.duration ?? 0,
      });
    },
    [inline],
  );

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
    bufferDocRef.current = doc;
    if (cancelled) return;
    setMeta({ name: doc.name, bpm: doc.bpm, code });
    setPhase({ kind: "rendering" });
    void (async () => {
      try {
        const { generateFactoryBank } = await import("../sample-library/factory");
        const bank = await generateFactoryBank();
        bankRef.current = bank;
        // The user sample bank is local to the creator's browser — freeze
        // handles those tracks; anything missing simply renders silently.
        // Dynamic: the offline renderer drags AudioEngine + the worklet
        // loaders into the chunk graph — keep it out of the landing/embed
        // static payload (landing-route size budget).
        const { renderProject } = await import("../rendering/renderer");
        const buffer = await renderProject(doc, bank, { mode: "song", sampleRate: 44100 });
        if (cancelled) return;
        buffersRef.current[1] = buffer;
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

  // ── energy variants (share page only — inline cards stay single-render) ─
  useEffect(() => {
    if (inline || phase.kind !== "ready" || variantsRef.current !== "idle") return;
    let cancelled = false;
    const doc = bufferDocRef.current;
    const authored = buffersRef.current[1];
    if (!doc || !authored) return;
    // Variants triple the render memory — skip on long beats and small
    // devices instead of shipping a slider that can stall the tab.
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (authored.duration > 420 || (deviceMemory != null && deviceMemory < 2)) {
      setVariantsState("unavailable");
      return;
    }
    setVariantsState("rendering");
    void (async () => {
      try {
        const { renderProject } = await import("../rendering/renderer");
        const bank = bankRef.current;
        if (!bank) {
          setVariantsState("unavailable");
          return;
        }
        const opts = { mode: "song" as const, sampleRate: 44100 };
        const dark = await renderProject(applyEnergy(doc, DARK_LEVEL), bank, opts);
        if (cancelled) return;
        buffersRef.current[0] = dark;
        const bright = await renderProject(applyEnergy(doc, BRIGHT_LEVEL), bank, opts);
        if (cancelled) return;
        buffersRef.current[2] = bright;
        setVariantsState("ready");
        postToParent({ type: "kyx:energy-ready" });
        // Mid-playback arrival: join the running authored source with the two
        // extra variants at the same offset, silent until the slider moves.
        if (playingRef.current) ensureVariantSources();
      } catch {
        if (!cancelled) setVariantsState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, setVariantsState]);

  // ── playback ────────────────────────────────────────────────────────────
  const stopSource = useCallback((index: number) => {
    const source = sourcesRef.current[index];
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      source.disconnect();
      sourcesRef.current[index] = null;
    }
  }, []);

  const stopAllSources = useCallback(() => {
    for (let i = 0; i < 3; i++) stopSource(i);
  }, [stopSource]);

  const ensureGraph = useCallback((ctx: AudioContext) => {
    if (gainsRef.current) return gainsRef.current;
    const gains: [GainNode, GainNode, GainNode] = [ctx.createGain(), ctx.createGain(), ctx.createGain()];
    for (const gain of gains) gain.connect(ctx.destination);
    gainsRef.current = gains;
    return gains;
  }, []);

  const activeWeights = useCallback((): [number, number, number] => {
    if (variantsRef.current !== "ready") return [0, 1, 0];
    return energyWeights(energyRef.current);
  }, []);

  /** Start one variant source at the current transport offset with `weight`. */
  const startVariant = useCallback(
    (index: number, weight: number) => {
      const ctx = ctxRef.current;
      const buffer = buffersRef.current[index];
      if (!ctx || !buffer) return;
      stopSource(index);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ensureGraph(ctx)[index];
      source.connect(gain);
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(weight, ctx.currentTime);
      const offset = Math.min(offsetRef.current, buffer.duration - 0.05);
      source.start(0, Math.max(0, offset));
      sourcesRef.current[index] = source;
    },
    [ensureGraph, stopSource],
  );

  /** Mid-playback variant injection — no restart of the running authored source. */
  const ensureVariantSources = useCallback(() => {
    const weights = activeWeights();
    for (const index of [0, 2]) {
      if (sourcesRef.current[index] == null && buffersRef.current[index]) startVariant(index, weights[index]);
    }
  }, [activeWeights, startVariant]);

  const play = useCallback(() => {
    const buffer = buffersRef.current[1];
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
    if (exclusiveGroup) {
      const token = groupTokenRef.current;
      for (const [peer, pausePeer] of exclusiveGroups.get(exclusiveGroup) ?? []) {
        if (peer !== token) pausePeer();
      }
    }
    stopAllSources();
    const weights = activeWeights();
    for (let i = 0; i < 3; i++) {
      if (buffersRef.current[i]) startVariant(i, weights[i]);
    }
    startedAtRef.current = ctx.currentTime - offsetRef.current;
    playingRef.current = true;
    setPlaying(true);
    postState(true);
    try {
      onPlayed?.();
    } catch {
      /* observer must not break playback */
    }
  }, [stopAllSources, activeWeights, startVariant, onPlayed, postState, exclusiveGroup]);

  const pause = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) return;
    offsetRef.current = Math.min(ctx.currentTime - startedAtRef.current, buffersRef.current[1]?.duration ?? 0);
    stopAllSources();
    playingRef.current = false;
    setPlaying(false);
    postState(true);
  }, [stopAllSources, postState]);

  pauseRef.current = pause;

  // Exclusive groups: joining players pause their group siblings on play.
  // Registered by token so a player never pauses itself.
  const groupTokenRef = useRef<object | null>(null);
  useEffect(() => {
    if (!exclusiveGroup) return;
    const token = groupTokenRef.current ?? (groupTokenRef.current = {});
    const map = exclusiveGroups.get(exclusiveGroup) ?? new Map<object, () => void>();
    map.set(token, () => {
      if (playingRef.current) pauseRef.current();
    });
    exclusiveGroups.set(exclusiveGroup, map);
    return () => {
      map.delete(token);
      if (map.size === 0) exclusiveGroups.delete(exclusiveGroup);
    };
  }, [exclusiveGroup]);

  const seek = useCallback(
    (fraction: number) => {
      const buffer = buffersRef.current[1];
      if (!buffer) return;
      const clamped = Math.max(0, Math.min(0.999, fraction));
      const wasPlaying = playingRef.current;
      offsetRef.current = clamped * buffer.duration;
      setProgress(clamped);
      if (wasPlaying) play();
    },
    [play],
  );

  /** Apply a new energy level: state, crossfade weights, host notification. */
  const setEnergyValue = useCallback(
    (value: number) => {
      const clamped = Math.max(0, Math.min(1, value));
      energyRef.current = clamped;
      setEnergy(clamped);
      const ctx = ctxRef.current;
      const gains = gainsRef.current;
      if (ctx && gains && playingRef.current && variantsRef.current === "ready") {
        const weights = energyWeights(clamped);
        for (let i = 0; i < 3; i++) {
          gains[i].gain.setTargetAtTime(weights[i], ctx.currentTime, 0.03);
        }
      }
      postState(true);
    },
    [postState],
  );

  // Progress loop while playing (+ throttled host state posts).
  useEffect(() => {
    const tick = () => {
      const ctx = ctxRef.current;
      const buffer = buffersRef.current[1];
      if (ctx && buffer && playingRef.current) {
        const t = ctx.currentTime - startedAtRef.current;
        setProgress(Math.min(1, t / buffer.duration));
        postState(false);
        if (t >= buffer.duration) {
          playingRef.current = false;
          offsetRef.current = 0;
          setPlaying(false);
          setProgress(0);
          postState(true);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      stopAllSources();
      void ctxRef.current?.close().catch(() => {});
    };
  }, [stopAllSources]);

  // ── postMessage control API (skipped for inline usage) ──────────────────
  useEffect(() => {
    if (inline || typeof window === "undefined") return;
    const onMessage = (event: MessageEvent) => {
      const command = parseEmbedCommand(event.data);
      if (!command) return;
      switch (command.kind) {
        case "energy":
          setEnergyValue(command.value);
          break;
        case "play":
          play();
          break;
        case "pause":
          pause();
          break;
        case "toggle":
          if (playingRef.current) pause();
          else play();
          break;
        case "seek":
          seek(command.value);
          break;
        case "getState":
          postState(true);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [inline, play, pause, seek, setEnergyValue]);

  // ── streamer hotkeys (skipped for inline usage) ─────────────────────────
  useEffect(() => {
    if (inline || typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setEnergyValue(energyRef.current + 0.1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setEnergyValue(energyRef.current - 0.1);
      } else if (event.key === "1") {
        setEnergyValue(0);
      } else if (event.key === "2") {
        setEnergyValue(0.5);
      } else if (event.key === "3") {
        setEnergyValue(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline, setEnergyValue]);

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
  // B2 share-view CTA: when the beat carries intent provenance, the studio
  // can regenerate it — one extra link, zero extra engine weight here.
  const regenUrl = meta ? `${openUrl}&regen=1` : "#";
  const regenerable = useMemo(() => {
    const doc = bufferDocRef.current;
    if (!doc || !Array.isArray(doc.patterns)) return false;
    // Same provenance contract as the gallery regen carry: the engine stamps
    // `pattern.generation.intent`; legacy top-level `intent` still counts.
    return intentSnapshotOfDoc(doc) !== null;
  }, [meta]);
  const duration = buffersRef.current[1]?.duration ?? 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const energyActive = !inline && phase.kind === "ready" && variants !== "unavailable";

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
      {energyActive && (
        <div className="embed-energy">
          <span className="embed-energy-label">ENERGY</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(energy * 100)}
            disabled={variants !== "ready"}
            aria-label="Energy"
            aria-valuetext={`${Math.round(energy * 100)}% energy`}
            title={
              variants === "ready"
                ? "Ride the beat — dark skeleton (0) to full drop (100)"
                : "Calibrating energy variants…"
            }
            onChange={(e) => setEnergyValue(Number(e.target.value) / 100)}
          />
          <span className="embed-energy-value">{variants === "ready" ? `${Math.round(energy * 100)}%` : "…"}</span>
        </div>
      )}
      <div className="embed-footer">
        <span className="embed-meta">{meta ? `${meta.name} · ${Math.round(meta.bpm)} BPM` : "…"}</span>
        <span className="embed-status" data-phase={phase.kind}>
          {phase.kind === "rendering" ? "rendering…" : ""}
          {phase.kind === "error" ? phase.message : ""}
        </span>
        <div className="embed-actions">
          {regenerable && (
            <a className="embed-cta embed-cta-ghost" href={regenUrl} target="_blank" rel="noreferrer">
              REMIX IN KYX
            </a>
          )}
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

/** Exclusive playback groups — token-keyed so a player never pauses itself. */
const exclusiveGroups = new Map<string, Map<object, () => void>>();

/** Fire-and-forget post to the embedding page (never the same-origin studio). */
function postToParent(message: Record<string, unknown>) {
  if (typeof window === "undefined" || window.parent == null || window.parent === window) return;
  try {
    // The payload carries playback state only (no user data), and public
    // embeds live on unknown hosts — a targeted origin is impossible.
    window.parent.postMessage(message, "*");
  } catch {
    /* host may be gone — the beat keeps playing */
  }
}
