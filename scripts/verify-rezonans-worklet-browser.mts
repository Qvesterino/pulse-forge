import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const workletPath = path.join(root, "public", "rezonans-worklet.js");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
  } else if (pathname === "/rezonans-worklet.js") {
    response
      .writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
      .end(await readFile(workletPath));
  } else {
    response.writeHead(404).end();
  }
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("REZONANS browser check did not get a local port");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frames = sampleRate * 2;
    const context = new OfflineAudioContext(2, frames, sampleRate);
    await context.audioWorklet.addModule("/rezonans-worklet.js");

    let latencySamples: number | null = null;
    let processorError = false;
    let resolveLatency: (() => void) | undefined;
    const latencyReported = new Promise<void>((resolve) => {
      resolveLatency = resolve;
    });
    const node = new AudioWorkletNode(context, "rezonans-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      processorOptions: {
        bpm: 120,
        harmonyContext: { keyRootPc: 0, scaleMask: 0b101010110101, chords: [] },
        params: {
          quality: 2,
          mix: 1,
          "harmony.mode": 4,
          "harmony.voices": 1,
          "harmony.bodyGate": 1,
          "detect.clarity": 0.2,
          "voice0.enabled": 1,
          "voice0.note": 64,
          "voice0.level": 1,
          "voice0.humanize": 0,
        },
      },
    });
    node.port.onmessage = (event: MessageEvent<{ type?: string; samples?: number }>) => {
      if (event.data?.type === "latency" && Number.isInteger(event.data.samples)) {
        latencySamples = event.data.samples ?? null;
        resolveLatency?.();
      }
    };
    node.onprocessorerror = () => {
      processorError = true;
    };

    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const inputGain = context.createGain();
    inputGain.gain.value = 0.12;
    oscillator.connect(inputGain).connect(node);
    node.connect(context.destination);
    oscillator.start(0);

    const rendered = await context.startRendering();
    await Promise.race([latencyReported, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);

    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    let peak = 0;
    let sumSquares = 0;
    let finite = true;
    for (let i = 0; i < frames; i++) {
      const l = left[i]!;
      const r = right[i]!;
      if (!Number.isFinite(l) || !Number.isFinite(r)) finite = false;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sumSquares += l * l + r * r;
    }

    const expectedHz = 440 * Math.pow(2, (64 - 69) / 12);
    const windowStart = 4095 + Math.floor(0.5 * sampleRate);
    const windowLength = 8192;
    const amplitudeAt = (frequency: number) => {
      let re = 0;
      let im = 0;
      for (let i = windowStart; i < windowStart + windowLength; i++) {
        const phase = (2 * Math.PI * frequency * i) / sampleRate;
        re += left[i]! * Math.cos(phase);
        im -= left[i]! * Math.sin(phase);
      }
      return (2 * Math.hypot(re, im)) / windowLength;
    };
    let peakHz = 280;
    let peakAmplitude = 0;
    for (let frequency = 280; frequency <= 380; frequency++) {
      const amplitude = amplitudeAt(frequency);
      if (amplitude > peakAmplitude) {
        peakAmplitude = amplitude;
        peakHz = frequency;
      }
    }
    const targetAmplitude = amplitudeAt(expectedHz);
    const sourceAmplitude = amplitudeAt(220);
    const pitchErrorSemitones = 12 * Math.log2(peakHz / expectedHz);

    return {
      browser: navigator.userAgent,
      sampleRate,
      frames,
      processorError,
      latencySamples,
      expectedLatencySamples: 4_095,
      peak,
      rms: Math.sqrt(sumSquares / (frames * 2)),
      finite,
      expectedHz,
      peakHz,
      targetAmplitude,
      sourceAmplitude,
      pitchErrorSemitones,
    };
  });

  console.log(JSON.stringify({ check: "REZONANS shipped AudioWorklet — MANUAL NOTES target", ...result }, null, 2));
  if (result.processorError) throw new Error("REZONANS AudioWorklet reported processorerror");
  if (result.latencySamples !== result.expectedLatencySamples) {
    throw new Error(
      `REZONANS reported ${result.latencySamples} latency samples, expected ${result.expectedLatencySamples}`,
    );
  }
  if (!result.finite || !(result.rms > 1e-5) || !(result.peak < 1)) {
    throw new Error(`REZONANS output failed finite/audible/headroom checks (rms=${result.rms}, peak=${result.peak})`);
  }
  if (!(result.targetAmplitude > result.sourceAmplitude * 2) || !(Math.abs(result.pitchErrorSemitones) < 0.75)) {
    throw new Error(
      `MANUAL NOTES did not render the selected E4 target (peak=${result.peakHz}Hz, ` +
        `target=${result.expectedHz.toFixed(2)}Hz, source=${result.sourceAmplitude.toFixed(4)}, ` +
        `target amplitude=${result.targetAmplitude.toFixed(4)})`,
    );
  }

  const formantResult = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frames = sampleRate * 2;
    const harmonicGains = new Float64Array(31);
    for (let h = 1; h < harmonicGains.length; h++) {
      const f = 220 * h;
      const bump = (center: number, width: number, gain: number) => gain * Math.exp(-0.5 * ((f - center) / width) ** 2);
      harmonicGains[h] = (0.15 + bump(700, 120, 2.3) + bump(1450, 180, 1.9) + bump(2700, 240, 1.0)) / h;
    }
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const phase = (2 * Math.PI * 220 * i) / sampleRate;
      let sample = 0;
      for (let h = 1; h < harmonicGains.length; h++) sample += Math.sin(phase * h) * harmonicGains[h]!;
      input[i] = sample * 0.16;
    }

    const render = async (formant: number) => {
      const context = new OfflineAudioContext(2, frames, sampleRate);
      await context.audioWorklet.addModule("/rezonans-worklet.js");
      let processorError = false;
      const node = new AudioWorkletNode(context, "rezonans-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        processorOptions: {
          bpm: 120,
          harmonyContext: { keyRootPc: 0, scaleMask: 0b101010110101, chords: [] },
          params: {
            quality: 2,
            mix: 1,
            formant,
            "harmony.mode": 1,
            "harmony.voices": 1,
            "harmony.bodyGate": 0,
            "detect.clarity": 0.2,
            "voice0.enabled": 1,
            "voice0.degree": 0,
            "voice0.level": 1,
            "voice0.pan": 0,
            "voice0.humanize": 0,
          },
        },
      });
      node.onprocessorerror = () => {
        processorError = true;
      };
      const buffer = context.createBuffer(2, frames, sampleRate);
      buffer.copyToChannel(input, 0);
      buffer.copyToChannel(input, 1);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      node.connect(context.destination);
      source.start(0);
      const rendered = await context.startRendering();
      const data = rendered.getChannelData(0);
      const from = Math.floor(data.length * 0.4);
      const coef = Math.exp((-2 * Math.PI * 1500) / sampleRate);
      let low = 0;
      let lowEnergy = 0;
      let highEnergy = 0;
      let rmsEnergy = 0;
      for (let i = from; i < data.length; i++) {
        const x = data[i]!;
        low = coef * low + (1 - coef) * x;
        const high = x - low;
        lowEnergy += low * low;
        highEnergy += high * high;
        rmsEnergy += x * x;
      }
      return {
        processorError,
        highBandRatio: highEnergy / Math.max(lowEnergy, 1e-12),
        rms: Math.sqrt(rmsEnergy / (data.length - from)),
      };
    };

    const flat = await render(0);
    const raised = await render(8);
    return { flat, raised, ratioLift: raised.highBandRatio / Math.max(flat.highBandRatio, 1e-12) };
  });
  console.log(JSON.stringify({ check: "REZONANS shipped AudioWorklet — FORMANT shift", ...formantResult }, null, 2));
  if (
    formantResult.flat.processorError ||
    formantResult.raised.processorError ||
    !(formantResult.flat.rms > 1e-5) ||
    !(formantResult.raised.rms > 1e-5) ||
    !(formantResult.raised.highBandRatio > formantResult.flat.highBandRatio * 1.15)
  ) {
    throw new Error(
      `FORMANT shift did not raise the high-band share (flat=${formantResult.flat.highBandRatio}, ` +
        `raised=${formantResult.raised.highBandRatio}, lift=${formantResult.ratioLift})`,
    );
  }

  const sanitizationResult = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frames = sampleRate;
    const modes = [
      { "harmony.mode": 0, mix: 0.5 },
      { "harmony.mode": 2, mix: 0 },
      {
        quality: 0,
        mix: 1,
        "harmony.mode": 4,
        "harmony.voices": 1,
        "harmony.bodyGate": 0,
        "detect.clarity": 0.2,
        "voice0.enabled": 1,
        "voice0.note": 64,
        "voice0.level": 1,
        "voice0.humanize": 0,
      },
    ];
    const render = async (badInput: boolean, params: Record<string, number>) => {
      const context = new OfflineAudioContext(2, frames, sampleRate);
      await context.audioWorklet.addModule("/rezonans-worklet.js");
      let processorError = false;
      const node = new AudioWorkletNode(context, "rezonans-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        processorOptions: {
          bpm: 120,
          harmonyContext: { keyRootPc: 0, scaleMask: 0b101010110101, chords: [] },
          params,
        },
      });
      node.onprocessorerror = () => {
        processorError = true;
      };
      const buffer = context.createBuffer(2, frames, sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        const sample = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
        left[i] = sample;
        right[i] = sample * 0.75;
      }
      if (badInput) {
        left[2048] = Number.NaN;
        left[2049] = Number.POSITIVE_INFINITY;
        left[2050] = 1e20;
        right[4096] = Number.NEGATIVE_INFINITY;
        right[4097] = -1e20;
      } else {
        left[2048] = 0;
        left[2049] = 0;
        left[2050] = 8;
        right[4096] = 0;
        right[4097] = -8;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      node.connect(context.destination);
      source.start(0);
      const rendered = await context.startRendering();
      return {
        left: new Float32Array(rendered.getChannelData(0)),
        right: new Float32Array(rendered.getChannelData(1)),
        processorError,
      };
    };

    let maxDiff = 0;
    let finite = true;
    let activeTailEnergy = 0;
    let activeTailSamples = 0;
    let activeTailPeak = 0;
    let processorError = false;
    for (let modeIndex = 0; modeIndex < modes.length; modeIndex++) {
      const mode = modes[modeIndex]!;
      const actual = await render(true, mode);
      const expected = await render(false, mode);
      processorError ||= actual.processorError || expected.processorError;
      for (let i = 0; i < frames; i++) {
        const actualL = actual.left[i]!;
        const actualR = actual.right[i]!;
        finite &&= Number.isFinite(actualL) && Number.isFinite(actualR);
        maxDiff = Math.max(maxDiff, Math.abs(actualL - expected.left[i]!), Math.abs(actualR - expected.right[i]!));
        if (modeIndex === 2 && i >= 5_000) {
          activeTailEnergy += actualL * actualL + actualR * actualR;
          activeTailSamples += 2;
          activeTailPeak = Math.max(activeTailPeak, Math.abs(actualL), Math.abs(actualR));
        }
      }
    }
    const activeTailRms = Math.sqrt(activeTailEnergy / Math.max(1, activeTailSamples));
    return { processorError, finite, maxDiff, activeTailRms, activeTailPeak };
  });
  console.log(
    JSON.stringify({ check: "REZONANS shipped AudioWorklet — input sanitization", ...sanitizationResult }, null, 2),
  );
  if (
    sanitizationResult.processorError ||
    !sanitizationResult.finite ||
    sanitizationResult.maxDiff > 1e-6 ||
    !(sanitizationResult.activeTailRms > 0.01) ||
    !(sanitizationResult.activeTailRms < 0.2) ||
    !(sanitizationResult.activeTailPeak < 1)
  ) {
    throw new Error(
      `input sanitization mismatch (finite=${sanitizationResult.finite}, ` +
        `maxDiff=${sanitizationResult.maxDiff}, activeTailRms=${sanitizationResult.activeTailRms}, ` +
        `activeTailPeak=${sanitizationResult.activeTailPeak})`,
    );
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
