import { describe, it, expect, afterEach } from "vitest";
import {
  setSttModelMode,
  ensureStt,
  transcribeWithStt,
  onSttStateChange,
  resetSttLoaderForTests,
  setSttWorkerFactoryForTests,
} from "../src/intent/stt-loader";
import { isSttManifest } from "../src/intent/stt-loader-types";
import { createVoiceCapture } from "../src/intent/voice-capture";

/**
 * LOCAL STT DRAWER — loader contract with a FAKE worker. The real whisper
 * runtime is vendored separately (manifest.runtime); these tests pin the
 * loader guarantees that hold regardless of the artifact: opt-in flag,
 * manifest probe, transcript round-trip, breaker after two failures,
 * controlled null on every failure path.
 */

/** Fake worker speaking the stt-worker message protocol. */
function fakeWorker(
  script: (request: { id: number; type: string }, post: (response: unknown) => void) => void,
): Worker {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const fake = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
    postMessage(message: { id: number; type: string }) {
      setTimeout(() => {
        const deliver = (response: unknown) => {
          if (fake.onmessage) fake.onmessage({ data: response } as MessageEvent);
          for (const listener of listeners) listener({ data: response } as MessageEvent);
        };
        script(message, deliver);
      }, 0);
    },
    terminate() {},
    addEventListener(_: string, listener: (event: MessageEvent) => void) {
      listeners.push(listener);
    },
    removeEventListener(_: string, listener: (event: MessageEvent) => void) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return fake as unknown as Worker;
}

afterEach(() => {
  setSttWorkerFactoryForTests(null);
  setSttModelMode("off");
  resetSttLoaderForTests();
});

describe("stt loader", () => {
  it("flag off (default) → transcribe resolves null without any worker", async () => {
    let spawned = 0;
    setSttWorkerFactoryForTests(() => {
      spawned += 1;
      return fakeWorker(() => {});
    });
    setSttModelMode("off");
    const samples = new Float32Array(16000);
    expect(await transcribeWithStt(samples, 16000)).toBeNull();
    expect(spawned).toBe(0);
  });

  it("manifest 404 → unavailable state, transcribe null", async () => {
    setSttModelMode("on");
    const states: string[] = [];
    onSttStateChange((state) => states.push(state));
    // no worker factory — the probe runs first and 404s (fetch of the test
    // origin has no models/stt-v1.manifest.json)
    expect(await transcribeWithStt(new Float32Array(16000), 16000)).toBeNull();
    expect(states).toContain("unavailable");
  });

  it("happy path: probe → load → transcribe round-trips the transcript", async () => {
    setSttModelMode("on");
    setSttWorkerFactoryForTests(() =>
      fakeWorker((request, post) => {
        if (request.type === "load") post({ type: "loaded", id: request.id, version: "test" });
        if (request.type === "transcribe") post({ type: "result", id: request.id, text: "zníž basu" });
      }),
    );
    expect(await ensureStt()).toBe(true);
    expect(await transcribeWithStt(new Float32Array(16000), 16000)).toBe("zníž basu");
  });

  it("breaker: two transcribe errors disable the worker (third call nulls fast)", async () => {
    setSttModelMode("on");
    let failures = 0;
    setSttWorkerFactoryForTests(() =>
      fakeWorker((request, post) => {
        if (request.type === "load") post({ type: "loaded", id: request.id, version: "test" });
        if (request.type === "transcribe") {
          failures += 1;
          post({ type: "error", id: request.id, message: "runtime boom" });
        }
      }),
    );
    await ensureStt();
    expect(await transcribeWithStt(new Float32Array(16000), 16000)).toBeNull(); // failure 1
    expect(await transcribeWithStt(new Float32Array(16000), 16000)).toBeNull(); // failure 2 → breaker
    expect(failures).toBe(2);
    const third = await transcribeWithStt(new Float32Array(16000), 16000);
    expect(third).toBeNull();
    expect(failures).toBe(2); // third call never reached the worker
  });
});

describe("stt manifest guard", () => {
  it("accepts a well-formed manifest and rejects broken ones", () => {
    const good = {
      sttModelVersion: "whisper-tiny",
      schemaVersion: 1,
      runtime: { kind: "whisper-wasm", module: "/models/stt/runtime.js", export: "transcribe" },
      model: { url: "/models/stt/w.bin", bytes: 10, sha256: "cd".repeat(32) },
      audio: { sampleRate: 16000, language: "multi" },
    };
    expect(isSttManifest(good)).toBe(true);
    expect(isSttManifest({ ...good, model: { ...good.model, sha256: "nothex" } })).toBe(false);
    expect(isSttManifest({ ...good, audio: { ...good.audio, sampleRate: 44100 } })).toBe(false);
    expect(isSttManifest(null)).toBe(false);
  });
});

describe("voice capture guards", () => {
  it("inactive capture: stopAndTranscribe and cancel resolve without a mic", async () => {
    const capture = createVoiceCapture();
    expect(capture.active).toBe(false);
    expect(await capture.stopAndTranscribe()).toBeNull(); // no chunks → null
    capture.cancel();
    expect(capture.active).toBe(false);
  });
});
