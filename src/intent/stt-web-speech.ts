/**
 * WEB SPEECH API STT — browser-native fallback (W0.3, intent-killer-feature-plan).
 *
 * Uses the browser's built-in SpeechRecognition (Chromium/Edge) instead of
 * the (not-yet-shipped) Whisper ONNX model. Zero download, zero worker, zero
 * model manifest — the browser does the inference natively. Not available in
 * Firefox/Safari; those keep the honest "stt runtime not available" state.
 *
 * Same VoiceCapture contract as voice-capture.ts, so the IntentPanel can
 * swap providers transparently: start() begins recognition, stopAndTranscribe()
 * resolves the transcript. The `continuous` + `interimResults` pattern gives
 * us a live transcript that the caller can show while the user speaks.
 *
 * Lifecycle:
 *   const capture = createWebSpeechCapture();
 *   await capture.start();                    // starts listening
 *   const text = await capture.stopAndTranscribe(); // stops + resolves
 *
 * If the browser lacks SpeechRecognition, `create()` returns null and the
 * caller falls back to the Whisper loader (which is itself a stub today —
 * the honest outcome is the same: "stt not available").
 */

export interface WebSpeechCapture {
  readonly active: boolean;
  readonly supported: boolean;
  start(): Promise<boolean>;
  stopAndTranscribe(): Promise<string | null>;
  cancel(): void;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, SpeechRecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isWebSpeechSupported(): boolean {
  return getRecognitionCtor() != null;
}

export function createWebSpeechCapture(lang = "en-US"): WebSpeechCapture | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  let recognition: SpeechRecognitionLike | null = null;
  let active = false;
  let finalTranscript = "";
  let interimTranscript = "";
  let error: string | null = null;

  function buildRecognition(): SpeechRecognitionLike {
    const rec = new (Ctor as SpeechRecognitionCtor)();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final += text;
        else interim += text;
      }
      finalTranscript = final.trim();
      interimTranscript = interim.trim();
    };
    rec.onerror = (event) => {
      error = event.error;
      active = false;
    };
    rec.onend = () => {
      active = false;
    };
    return rec;
  }

  return {
    get active() {
      return active;
    },
    get supported() {
      return true;
    },
    async start() {
      try {
        recognition = buildRecognition();
        finalTranscript = "";
        interimTranscript = "";
        error = null;
        recognition.start();
        active = true;
        return true;
      } catch {
        return false;
      }
    },
    async stopAndTranscribe() {
      if (!recognition || !active) return null;
      recognition.stop();
      // SpeechRecognition results arrive asynchronously after stop() —
      // wait briefly for the final transcript to settle.
      for (let i = 0; i < 20; i++) {
        if (finalTranscript || error) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      active = false;
      if (error) return null;
      return finalTranscript || interimTranscript || null;
    },
    cancel() {
      recognition?.stop();
      active = false;
      finalTranscript = "";
      interimTranscript = "";
    },
  };
}
