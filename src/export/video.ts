/**
 * Video export: renders the offline-rendered audio against an on-brand
 * canvas visualization (waveform + playhead + step pulse) and records it
 * with MediaRecorder — a ready-to-post vertical clip for Reels/Shorts/TikTok.
 *
 * Audio is played into a MediaStreamAudioDestinationNode only (silent to
 * the speakers) and muxed with the canvas video track. Recording is
 * real-time: a 15 s clip takes 15 s — progress is reported for the UI.
 */

const BRAND = {
  bg: "#0e0f12",
  panel: "#15171c",
  accent: "#f59e0b",
  accentDim: "rgba(245, 158, 11, 0.30)",
  accentFaint: "rgba(245, 158, 11, 0.12)",
  text: "#f4f4f5",
  textDim: "#71717a",
  playedDim: "#3f3f46",
};

export interface VideoOptions {
  title: string;
  bpm: number;
  /** Clip length in seconds (the rendered audio is trimmed to this). */
  seconds: number;
  width?: number;
  height?: number;
  fps?: number;
  onProgress?: (fraction: number) => void;
  /** Abort support (release roadmap 1.4): checked each frame + before stop. */
  signal?: AbortSignal;
}

export interface VideoResult {
  blob: Blob;
  ext: "mp4" | "webm";
  bytes: number;
}

/** MediaRecorder + canvas.captureStream available and a usable codec? */
export function canExportVideo(): boolean {
  if (typeof MediaRecorder === "undefined" || typeof document === "undefined") return false;
  return pickVideoMimeType() !== null;
}

/** Prefer MP4 (directly uploadable to socials), fall back to WebM. */
export function pickVideoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4",
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    "video/webm",
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported can throw on exotic codecs — keep probing
    }
  }
  return null;
}

interface WaveColumn {
  min: number;
  max: number;
}

function buildEnvelope(buffer: AudioBuffer, columns: number): WaveColumn[] {
  const data = buffer.getChannelData(0);
  const per = Math.max(1, Math.floor(data.length / columns));
  const env: WaveColumn[] = [];
  for (let c = 0; c < columns; c++) {
    let min = 1;
    let max = -1;
    const start = c * per;
    const end = Math.min(data.length, start + per);
    for (let i = start; i < end; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    env.push({ min: Math.min(min, 0), max: Math.max(max, 0) });
  }
  return env;
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  opts: { title: string; bpm: number; seconds: number },
  envelope: WaveColumn[],
  t: number,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const progress = Math.max(0, Math.min(1, t / opts.seconds));

  // Background + vignette
  ctx.fillStyle = BRAND.bg;
  ctx.fillRect(0, 0, w, h);
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.75);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  // Header: title + bpm chip
  ctx.textAlign = "left";
  ctx.fillStyle = BRAND.text;
  ctx.font = `700 ${Math.round(w * 0.066)}px system-ui, sans-serif`;
  const title = opts.title.length > 24 ? opts.title.slice(0, 23) + "…" : opts.title;
  ctx.fillText(title, w * 0.08, h * 0.12);
  ctx.font = `500 ${Math.round(w * 0.033)}px system-ui, sans-serif`;
  ctx.fillStyle = BRAND.textDim;
  ctx.fillText(`${Math.round(opts.bpm)} BPM · PULSE FORGE`, w * 0.08, h * 0.155);

  // Waveform band
  const bandTop = h * 0.24;
  const bandHeight = h * 0.46;
  const mid = bandTop + bandHeight / 2;
  const barCount = envelope.length;
  const slot = (w * 0.84) / barCount;
  const barW = Math.max(2, slot * 0.68);
  const x0 = w * 0.08;
  const playedX = x0 + w * 0.84 * progress;
  for (let i = 0; i < barCount; i++) {
    const col = envelope[i];
    const amp = Math.max(0.004, (col.max - col.min) / 2);
    const barH = amp * bandHeight;
    const x = x0 + i * slot;
    ctx.fillStyle = x <= playedX ? BRAND.accent : BRAND.playedDim;
    ctx.fillRect(x, mid - barH / 2, barW, barH);
  }

  // Playhead
  if (progress > 0) {
    ctx.fillStyle = BRAND.text;
    ctx.fillRect(playedX - Math.max(1.5, w * 0.002), bandTop - h * 0.02, Math.max(3, w * 0.004), bandHeight + h * 0.04);
  }

  // Step pulse dots (16th notes) — the "alive" element
  const secPerStep = 60 / opts.bpm / 4;
  const step = Math.floor(t / secPerStep);
  const dots = 16;
  const dotR = Math.max(3, w * 0.008);
  const dotGap = (w * 0.5) / dots;
  const dotsX0 = w / 2 - (dotGap * (dots - 1)) / 2;
  const dotsY = bandTop + bandHeight + h * 0.05;
  for (let i = 0; i < dots; i++) {
    const active = i === step % dots;
    const beat = i % 4 === 0;
    ctx.beginPath();
    ctx.arc(dotsX0 + i * dotGap, dotsY, active ? dotR * 1.7 : dotR, 0, Math.PI * 2);
    ctx.fillStyle = active ? BRAND.accent : beat ? BRAND.accentDim : BRAND.accentFaint;
    ctx.fill();
  }

  // Footer wordmark
  ctx.textAlign = "center";
  const mark = ctx.measureText("PF");
  ctx.fillStyle = BRAND.accent;
  ctx.fillRect(w / 2 - w * 0.075, h * 0.875, w * 0.055, w * 0.055);
  ctx.fillStyle = BRAND.bg;
  ctx.font = `700 ${Math.round(w * 0.03)}px system-ui, sans-serif`;
  ctx.fillText("PF", w / 2 - w * 0.075 + (w * 0.055 - mark.width) / 2, h * 0.875 + w * 0.04);
  ctx.fillStyle = BRAND.text;
  ctx.font = `700 ${Math.round(w * 0.045)}px system-ui, sans-serif`;
  ctx.fillText("PULSE FORGE", w / 2 + w * 0.02, h * 0.912);
  ctx.fillStyle = BRAND.textDim;
  ctx.font = `500 ${Math.round(w * 0.026)}px system-ui, sans-serif`;
  ctx.fillText("browser beat studio", w / 2, h * 0.945);
}

/**
 * Record a vertical clip of the rendered audio.
 * Throws when MediaRecorder or a usable codec is unavailable.
 */
export async function recordVideo(buffer: AudioBuffer, options: VideoOptions): Promise<VideoResult> {
  const mimeType = pickVideoMimeType();
  if (!mimeType || typeof document === "undefined") {
    throw new Error("Video export is not supported in this browser (MediaRecorder unavailable)");
  }
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const fps = options.fps ?? 30;
  const seconds = Math.max(1, Math.min(options.seconds, buffer.duration));

  const envelope = buildEnvelope(buffer, 108);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("Canvas 2D context unavailable");
  const frameOpts = { title: options.title, bpm: options.bpm, seconds };

  const audioCtx = new AudioContext();
  let stream: MediaStream | null = null;
  try {
    await audioCtx.resume().catch(() => {
      // Autoplay policies usually allow resume inside the click that
      // started the export; if not, recording still proceeds — Chromium
      // records silence from a suspended source. Best effort only.
    });
    const dest = audioCtx.createMediaStreamDestination();
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);

    stream = canvas.captureStream(fps);
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: width >= 1080 ? 8_000_000 : 2_500_000,
      audioBitsPerSecond: 192_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    // A recorder failure must reject — otherwise the export hung forever on
    // an `finished` promise nobody would ever settle.
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
      recorder.onerror = () => reject(new Error("Video recording failed (MediaRecorder error)"));
    });

    // First frame before recording starts — never ship a black frame.
    drawFrame(ctx2d, frameOpts, envelope, 0);
    recorder.start(250);
    const t0 = audioCtx.currentTime + 0.06;
    source.start(t0);
    source.stop(t0 + seconds);

    await new Promise<void>((resolve) => {
      // requestAnimationFrame stalls while the tab is hidden — without the
      // timer watchdog a backgrounded export never reaches recorder.stop()
      // and hangs forever. The watchdog resolves the loop from wall-clock
      // audio time when rAF is dead (frames simply stop updating).
      let watchdogCleared = false;
      let watchdog: ReturnType<typeof setInterval> | null = null;
      const resolveLoop = () => {
        if (!watchdogCleared) {
          watchdogCleared = true;
          if (watchdog) clearInterval(watchdog);
          resolve();
        }
      };
      watchdog = setInterval(() => {
        if (options.signal?.aborted || audioCtx.currentTime - t0 >= seconds + 0.25) resolveLoop();
      }, 500);
      const loop = () => {
        if (options.signal?.aborted) {
          resolveLoop();
          return;
        }
        const t = audioCtx.currentTime - t0;
        const clamped = Math.max(0, Math.min(seconds, t));
        drawFrame(ctx2d, frameOpts, envelope, clamped);
        options.onProgress?.(clamped / seconds);
        if (t < seconds + 0.25) {
          requestAnimationFrame(loop);
        } else {
          resolveLoop();
        }
      };
      requestAnimationFrame(loop);
    });

    if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    recorder.stop();
    const blob = await finished;
    return { blob, ext: mimeType.includes("mp4") ? "mp4" : "webm", bytes: blob.size };
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
    await audioCtx.close().catch(() => {});
  }
}
