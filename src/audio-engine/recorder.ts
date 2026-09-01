/**
 * Realtime recorder — "bounce what you hear" + mic/line capture.
 *
 * Taps a live AudioContext node (master post-limiter, a track's post-FX
 * analyser, or the microphone) into a MediaStreamAudioDestinationNode and
 * records it with MediaRecorder. The take is decoded back into an AudioBuffer
 * so it can be flipped onto a pad like any imported sample.
 *
 * Browser-bound by nature (MediaRecorder + getUserMedia): unit tests cover
 * the pure helpers, the browser check exercises a real master bounce.
 */

export type RecordSource = { kind: "master" } | { kind: "track"; trackId: string } | { kind: "mic" };

/** First supported MIME type, or null when MediaRecorder can't record audio. */
export function pickMimeType(candidates: string[], isSupported: (type: string) => boolean): string | null {
  for (const type of candidates) {
    if (isSupported(type)) return type;
  }
  return null;
}

/** File extension for a recorded MIME type (sample persistence + library display). */
export function extensionForMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return ".m4a";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("mpeg")) return ".mp3";
  return ".webm";
}

const DEFAULT_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export interface LiveRecorderDeps {
  /** A real (running) AudioContext — MediaStream nodes don't exist on BaseAudioContext. */
  ctx: AudioContext;
  /** Resolve the input tap for master/track sources (mic is handled internally). */
  getTapNode(source: RecordSource): AudioNode | null;
  mimeCandidates?: string[];
  isTypeSupported?: (type: string) => boolean;
}

export type RecorderState = "idle" | "recording";

export class LiveRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private dest: MediaStreamAudioDestinationNode | null = null;
  private tap: AudioNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private mimeType: string | null = null;
  private state_: RecorderState = "idle";
  private startedAt = 0;

  constructor(private deps: LiveRecorderDeps) {}

  get state(): RecorderState {
    return this.state_;
  }

  /** Seconds elapsed in the current take (0 when idle). */
  get elapsedSeconds(): number {
    return this.state_ === "recording" ? this.deps.ctx.currentTime - this.startedAt : 0;
  }

  /**
   * Arm + start recording from `source`. Throws with a user-readable message
   * when the environment can't record or the mic is unavailable.
   */
  async start(source: RecordSource): Promise<void> {
    if (this.state_ === "recording") throw new Error("Already recording");
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not available in this browser");
    const isSupported = this.deps.isTypeSupported ?? ((type: string) => MediaRecorder.isTypeSupported(type));
    const mimeType = pickMimeType(this.deps.mimeCandidates ?? DEFAULT_MIME_CANDIDATES, isSupported);
    if (!mimeType) throw new Error("No supported audio recording format in this browser");

    this.dest = this.deps.ctx.createMediaStreamDestination();
    if (source.kind === "mic") {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is not available in this browser");
      try {
        // Raw capture: DSP "enhancements" would fight the app's own processing.
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        throw new Error("Microphone access denied — allow the mic and try again");
      }
      this.micSource = this.deps.ctx.createMediaStreamSource(this.micStream);
      this.micSource.connect(this.dest);
    } else {
      this.tap = this.deps.getTapNode(source);
      if (!this.tap) throw new Error(source.kind === "track" ? "Track audio not loaded" : "Master audio not loaded");
      this.tap.connect(this.dest);
    }

    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(this.dest.stream, { mimeType });
    } catch {
      this.cleanupWiring();
      throw new Error("Could not start the recorder in this browser");
    }
    this.mimeType = mimeType;
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(250); // timeslice: long takes stay safe if the tab hiccups
    this.startedAt = this.deps.ctx.currentTime;
    this.state_ = "recording";
  }

  /**
   * Stop the take, decode it into an AudioBuffer and hand back the original
   * encoded bytes (sample persistence stores those — decoding alone would
   * lose the data the library needs across reloads). Returns null when
   * nothing usable was captured. All wiring (taps, mic stream) is torn down
   * either way.
   */
  async stop(): Promise<{ buffer: AudioBuffer; blob: Blob } | null> {
    if (this.state_ !== "recording" || !this.recorder) return null;
    const recorder = this.recorder;
    this.state_ = "idle";
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    try {
      recorder.stop();
    } catch {
      /* already inactive */
    }
    await stopped;
    const chunks = this.chunks;
    const mimeType = this.mimeType;
    this.cleanupWiring();
    if (chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: mimeType ?? "audio/webm" });
    if (blob.size < 1024) return null; // sub-1 kB is a failed take, not a sample
    try {
      const buffer = await this.deps.ctx.decodeAudioData(await blob.arrayBuffer());
      return { buffer, blob };
    } catch {
      return null;
    }
  }

  /** Abort without decoding — releases the mic and wiring immediately. */
  cancel(): void {
    if (this.recorder && this.state_ === "recording") {
      try {
        this.recorder.stop();
      } catch {
        /* already inactive */
      }
    }
    this.state_ = "idle";
    this.cleanupWiring();
  }

  private cleanupWiring(): void {
    this.recorder = null;
    this.chunks = [];
    const dest = this.dest;
    try {
      if (this.tap && dest) this.tap.disconnect(dest);
      else this.tap?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.tap = null;
    try {
      this.micSource?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.micSource = null;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.dest = null;
  }
}
