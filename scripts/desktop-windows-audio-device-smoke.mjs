/**
 * Run the real Windows shared-WASAPI utility and KYX AudioWorklet bridge with
 * silent render data. Capture is counted for diagnostics and is never saved.
 * This smoke does not represent the AudioEngine master or analog round-trip.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronExe = require("electron");
const root = fileURLToPath(new URL("..", import.meta.url));

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(
        "Usage: npm run desktop:audio:device-smoke -- --capture-id ID --render-id ID [--duration-ms 30000]",
      );
    options[key.slice(2)] = value;
    index++;
  }
  const inputEndpointId = options["capture-id"];
  const outputEndpointId = options["render-id"];
  if (!inputEndpointId || !outputEndpointId)
    throw new Error("Both --capture-id and --render-id are required; the smoke never chooses default endpoints");
  const sampleRateHz = Number(options["sample-rate-hz"] ?? 48_000);
  const periodFrames = Number(options["period-frames"] ?? 480);
  const durationMs = Number(options["duration-ms"] ?? 30_000);
  const inputChannelMap = String(options["capture-channels"] ?? "0,1").split(",").map(Number);
  const outputChannelMap = String(options["render-channels"] ?? "0,1").split(",").map(Number);
  for (const [name, value] of Object.entries({ sampleRateHz, periodFrames, durationMs }))
    if (!Number.isSafeInteger(value)) throw new Error(name + " must be an integer");
  if (durationMs < 5_000 || durationMs > 1_800_000)
    throw new Error("durationMs must be between 5000 and 1800000");
  return {
    durationMs,
    request: {
      backend: "wasapi-shared",
      inputEndpointId,
      outputEndpointId,
      sampleRateHz,
      periodFrames,
      inputChannelMap,
      outputChannelMap,
      exclusiveAcknowledged: false,
    },
  };
}

let configuration;
try {
  configuration = parseOptions(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (process.platform !== "win32") {
  console.error("The native WASAPI device smoke is Windows-only.");
  process.exit(2);
}
if (!existsSync(path.join(root, "dist", "index.html"))) {
  console.error("dist/index.html not found — run desktop:build (or a plain build) first.");
  process.exit(2);
}

const child = spawn(electronExe, ["desktop/main.cjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    KYX_SMOKE: "1",
    KYX_WINDOWS_AUDIO_DEVICE_SMOKE: "1",
    KYX_WINDOWS_AUDIO_DEVICE_SMOKE_REQUEST: JSON.stringify(configuration),
  },
});
child.once("exit", (code) => process.exit(code ?? 1));
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
