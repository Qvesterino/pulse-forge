import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const workletPath = path.join(root, "public", "skrutka-worklet.js");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
  } else if (pathname === "/skrutka-worklet.js") {
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
  if (!address || typeof address === "string") throw new Error("TWIST browser check did not get a local port");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frames = sampleRate;
    const seconds = frames / sampleRate;

    const render = async (
      params: Record<string, number>,
      programLeft: (sample: number) => number,
      programRight: (sample: number) => number,
      keyLeft?: (sample: number) => number,
      keyRight?: (sample: number) => number,
    ) => {
      const context = new OfflineAudioContext(2, frames, sampleRate);
      await context.audioWorklet.addModule("/skrutka-worklet.js");
      let processorError = false;
      const node = new AudioWorkletNode(context, "skrutka-processor", {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        processorOptions: { seed: 0x71a57 },
      });
      node.onprocessorerror = () => {
        processorError = true;
      };
      for (const [id, value] of Object.entries(params)) {
        const parameter = node.parameters.get(id);
        if (!parameter) throw new Error(`TWIST AudioParam '${id}' is missing`);
        parameter.setValueAtTime(value, 0);
      }

      const makeBuffer = (leftFn: (sample: number) => number, rightFn: (sample: number) => number) => {
        const buffer = context.createBuffer(2, frames, sampleRate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let i = 0; i < frames; i++) {
          left[i] = leftFn(i);
          right[i] = rightFn(i);
        }
        return buffer;
      };

      const program = context.createBufferSource();
      program.buffer = makeBuffer(programLeft, programRight);
      program.connect(node, 0, 0);
      if (keyLeft && keyRight) {
        const key = context.createBufferSource();
        key.buffer = makeBuffer(keyLeft, keyRight);
        key.connect(node, 0, 1);
        key.start(0);
      }
      node.connect(context.destination);
      program.start(0);
      const rendered = await context.startRendering();
      return {
        processorError,
        left: new Float32Array(rendered.getChannelData(0)),
        right: new Float32Array(rendered.getChannelData(1)),
      };
    };

    const sideTransient = (sample: number) => {
      const time = sample / sampleRate;
      return time > 0.05 && time < 0.35 ? 0.4 * Math.sin((2 * Math.PI * 180 * sample) / sampleRate) : 0;
    };
    const sideTransientWithCorruptPeak = (sample: number) => (sample === 2048 ? 1e20 : sideTransient(sample));
    const oppositeTransientWithCorruptPeak = (sample: number) => (sample === 2048 ? -1e20 : -sideTransient(sample));
    const dynamicBase = { dispersion: 0.55, punch: 0, focusHz: 180, spread: 0, field: 1, mix: 1 };
    const dynamicOff = await render(
      { ...dynamicBase, dyn: 0 },
      sideTransientWithCorruptPeak,
      oppositeTransientWithCorruptPeak,
    );
    const dynamicOn = await render(
      { ...dynamicBase, dyn: 1 },
      sideTransientWithCorruptPeak,
      oppositeTransientWithCorruptPeak,
    );

    let dynamicDifferenceEnergy = 0;
    const dynamicFrom = Math.floor(sampleRate * 0.055);
    const dynamicTo = Math.floor(sampleRate * 0.18);
    for (let i = dynamicFrom; i < dynamicTo; i++) {
      const leftDifference = dynamicOn.left[i]! - dynamicOff.left[i]!;
      const rightDifference = dynamicOn.right[i]! - dynamicOff.right[i]!;
      dynamicDifferenceEnergy += leftDifference * leftDifference + rightDifference * rightDifference;
    }

    const programTone = (sample: number) => 0.4 * Math.sin((2 * Math.PI * 80 * sample) / sampleRate);
    const keyBurst = (sample: number) => {
      const time = sample / sampleRate;
      return time >= 0.5 && time < 0.8 ? 0.8 * Math.sin((2 * Math.PI * 60 * sample) / sampleRate) : 0;
    };
    const keyBase = { dispersion: 0.3, punch: 0, focusHz: 90, spread: 0, mix: 1, keyMode: 1 };
    const monoKey = await render(keyBase, programTone, programTone, keyBurst, keyBurst);
    const sideOnlyKey = await render(keyBase, programTone, programTone, keyBurst, (sample) => -keyBurst(sample));
    const unkeyed = await render({ ...keyBase, keyMode: 0 }, programTone, programTone);

    let linkedKeyMaxDifference = 0;
    let keyEffectEnergy = 0;
    let finite = true;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      for (const sample of [
        dynamicOff.left[i]!,
        dynamicOff.right[i]!,
        dynamicOn.left[i]!,
        dynamicOn.right[i]!,
        monoKey.left[i]!,
        monoKey.right[i]!,
        sideOnlyKey.left[i]!,
        sideOnlyKey.right[i]!,
        unkeyed.left[i]!,
        unkeyed.right[i]!,
      ]) {
        finite &&= Number.isFinite(sample);
        peak = Math.max(peak, Math.abs(sample));
      }
      linkedKeyMaxDifference = Math.max(
        linkedKeyMaxDifference,
        Math.abs(sideOnlyKey.left[i]! - monoKey.left[i]!),
        Math.abs(sideOnlyKey.right[i]! - monoKey.right[i]!),
      );
      if (i >= Math.floor(sampleRate * 0.55) && i < Math.floor(sampleRate * 0.78)) {
        const difference = sideOnlyKey.left[i]! - unkeyed.left[i]!;
        keyEffectEnergy += difference * difference;
      }
    }

    return {
      browser: navigator.userAgent,
      seconds,
      processorError:
        dynamicOff.processorError ||
        dynamicOn.processorError ||
        monoKey.processorError ||
        sideOnlyKey.processorError ||
        unkeyed.processorError,
      finite,
      peak,
      dynamicDifferenceEnergy,
      linkedKeyMaxDifference,
      keyEffectEnergy,
    };
  });

  console.log(JSON.stringify({ check: "TWIST shipped AudioWorklet — stereo DYNAMIC and KEY", ...result }, null, 2));
  if (result.processorError || !result.finite || !(result.peak < 8)) {
    throw new Error(
      `TWIST browser output failed finite/headroom checks (finite=${result.finite}, peak=${result.peak})`,
    );
  }
  if (!(result.dynamicDifferenceEnergy > 0.01)) {
    throw new Error(`TWIST DYNAMIC did not process SIDE-only program audio (energy=${result.dynamicDifferenceEnergy})`);
  }
  if (!(result.linkedKeyMaxDifference < 1e-6) || !(result.keyEffectEnergy > 0.01)) {
    throw new Error(
      `TWIST KEY did not follow SIDE-only key audio (mono difference=${result.linkedKeyMaxDifference}, ` +
        `key response=${result.keyEffectEnergy})`,
    );
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
