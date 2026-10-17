/**
 * Runtime-only PCM MessagePort probe for `npm run desktop:smoke`.
 * This is a transport exercise, not an audio backend or a shipped host.
 */
const PERIOD_FRAMES = 480;
const CHANNELS = 2;
const PERIOD_SAMPLES = PERIOD_FRAMES * CHANNELS;
const MAX_SEQUENCE = 100;

let activePort = null;

function attach(port) {
  if (activePort) {
    port.close();
    return;
  }
  activePort = port;
  port.on("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "probe-result" || message.type === "probe-error") {
      process.parentPort.postMessage(message);
      port.postMessage({ type: "probe-result-ack" });
      return;
    }
    if (message.type !== "capture") return;
    const sequence = message.sequence;
    const samples = message.samples;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence >= MAX_SEQUENCE ||
      !(samples instanceof ArrayBuffer) ||
      samples.byteLength !== PERIOD_SAMPLES * Float32Array.BYTES_PER_ELEMENT
    ) {
      port.postMessage({ type: "error", message: "invalid or out-of-range PCM period" });
      return;
    }

    const input = new Float32Array(samples);
    const marker = sequence + 1;
    if (input.some((sample) => sample !== marker)) {
      port.postMessage({ type: "error", message: "PCM period data changed in transit" });
      return;
    }
    if (sequence === 0) process.parentPort.postMessage({ type: "first-period-received" });

    const output = new Float32Array(PERIOD_SAMPLES);
    output.fill(marker);
    port.postMessage({ type: "render", sequence, samples: output.buffer });
  });
  port.on("close", () => {
    if (activePort === port) activePort = null;
  });
  port.start();
  port.postMessage({ type: "ready" });
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  if (message?.type === "attach" && event.ports?.length === 1) {
    attach(event.ports[0]);
    process.parentPort.postMessage({ type: "port-attached" });
    return;
  }
  if (message?.type === "shutdown") {
    activePort?.close();
    activePort = null;
    process.parentPort.close();
    process.exit(0);
  }
});
process.parentPort.start();
