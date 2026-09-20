/**
 * Measure factory FX presets and beatmaking chains with the real effect
 * factories, then write conservative output compensation values.
 *
 * Preset gains are matched to the median within each effect type, across
 * drum, harmonic and vocal-like reference loops. Short chains are matched to
 * their dry reference loop, so auditioning a chain does not win simply by
 * being louder. This is a repeatable studio-reference measurement, not a
 * claim that one static trim can loudness-match every user's source.
 *
 * Usage: npm run presets:fx-loudness
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FX_PRESET_PORT) || 5238;
const outFile = path.join(root, "src", "effects", "preset-loudness.generated.ts");
const GAIN_MIN_DB = -18;
const GAIN_MAX_DB = 12;
const PEAK_CEILING_DB = -1;

const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
page.setDefaultNavigationTimeout(90_000);
page.on("console", (message) => {
  if (message.type() === "log") console.log(`[fx-loudness] ${message.text()}`);
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const registry = await import("/src/effects/registry.ts");
    const presets = await import("/src/effects/presets.ts");
    const chains = await import("/src/effects/chains.ts");
    const worklets = await import("/src/audio-worklets/loader.ts");
    const meter = await import("/src/audio-engine/kweighting.ts");
    const rng = await import("/src/shared/rng.ts");

    const SR = 44100;
    const GAIN_MIN_DB = -18;
    const GAIN_MAX_DB = 12;
    const PEAK_CEILING_DB = -1;
    const LOOP_SECONDS = 4;
    const RENDER_SECONDS = 6;
    const probeNames = ["drums", "harmonic", "voice"];
    const corePresets = presets.CORE_EFFECT_PRESETS;
    const presetById = new Map(corePresets.map((preset) => [preset.id, preset]));
    const neededTypes = new Set([
      ...corePresets.map((preset) => preset.type),
      ...chains.BEATMAKING_EFFECT_CHAINS.flatMap((chain) => chain.effects.map((item) => item.type)),
    ]);
    const cachedProbes = new Map();

    function probeBuffer(name) {
      if (cachedProbes.has(name)) return cachedProbes.get(name);
      const length = SR * LOOP_SECONDS;
      const left = new Float32Array(length);
      const right = new Float32Array(length);
      let randomState = rng.hashString(`pulse-forge-fx-reference-v1|${name}`);
      const random = () => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState / 4294967296;
      };
      const add = (channel, index, sample) => {
        if (index >= 0 && index < length) channel[index] += sample;
      };
      if (name === "drums") {
        for (let beat = 0; beat < 8; beat++) {
          const start = Math.round((beat * 60 / 120) * SR);
          if (beat % 2 === 0) {
            for (let i = 0; i < Math.round(0.24 * SR); i++) {
              const t = i / SR;
              const env = Math.exp(-t * 18);
              const phase = 2 * Math.PI * (48 * t + 24 * (1 - Math.exp(-t * 22)) / 22);
              const sample = 0.68 * env * Math.sin(phase);
              add(left, start + i, sample);
              add(right, start + i, sample * 0.98);
            }
          } else {
            for (let i = 0; i < Math.round(0.15 * SR); i++) {
              const t = i / SR;
              const noise = random() * 2 - 1;
              const sample = 0.32 * Math.exp(-t * 28) * noise + 0.12 * Math.exp(-t * 20) * Math.sin(2 * Math.PI * 185 * t);
              add(left, start + i, sample);
              add(right, start + i, sample * 0.88);
            }
          }
        }
        for (let sixteenth = 0; sixteenth < 32; sixteenth++) {
          const start = Math.round((sixteenth * 0.125) * SR);
          for (let i = 0; i < Math.round(0.028 * SR); i++) {
            const t = i / SR;
            const sample = 0.075 * Math.exp(-t * 115) * (random() * 2 - 1);
            add(left, start + i, sample);
            add(right, start + i, sample * (sixteenth % 2 ? 0.72 : 0.98));
          }
        }
      } else if (name === "harmonic") {
        const notes = [55, 82.41, 110, 164.81, 220];
        for (let beat = 0; beat < 8; beat++) {
          const start = Math.round((beat * 0.5) * SR);
          const root = beat < 4 ? 0 : 2;
          for (let i = 0; i < Math.round(0.48 * SR); i++) {
            const t = i / SR;
            const env = Math.exp(-t * 2.3);
            let sample = 0;
            for (let n = 0; n < 3; n++) sample += 0.105 * Math.sin(2 * Math.PI * notes[root + n] * t);
            sample += 0.08 * Math.sin(2 * Math.PI * (notes[root] * 2) * t);
            add(left, start + i, sample * env);
            add(right, start + i, sample * env * 0.94);
          }
        }
      } else {
        // A vowel-like additive voice with slow formant movement and a light
        // breath component. It is a deterministic reference, not a vocal IR.
        for (let beat = 0; beat < 8; beat += 2) {
          const start = Math.round((beat * 0.5) * SR);
          for (let i = 0; i < Math.round(0.82 * SR); i++) {
            const t = i / SR;
            const env = Math.min(1, t * 45) * Math.exp(-t * 1.35);
            const f0 = beat < 4 ? 130.81 : 146.83;
            let sample = 0;
            for (let harmonic = 1; harmonic <= 32; harmonic++) {
              const hz = f0 * harmonic;
              const formant = 0.75 * Math.exp(-Math.pow((hz - 720) / 420, 2)) +
                0.5 * Math.exp(-Math.pow((hz - 1450) / 650, 2)) +
                0.3 * Math.exp(-Math.pow((hz - 2600) / 900, 2));
              sample += (formant / harmonic) * Math.sin(2 * Math.PI * hz * t);
            }
            sample = 0.22 * env * sample + 0.012 * env * (random() * 2 - 1);
            add(left, start + i, sample);
            add(right, start + i, sample * 0.9);
          }
        }
      }
      const probe = { left, right };
      cachedProbes.set(name, probe);
      return probe;
    }

    function makeInstance(preset, probeName) {
      const params = registry.defaultParamsOf(preset.type);
      for (const [id, value] of Object.entries(preset.params)) params[id] = registry.clampEffectParam(preset.type, id, value);
      return {
        id: `fx-loudness-${preset.id}-${probeName}`,
        type: preset.type,
        bypassed: false,
        params,
        ...(preset.steps ? { steps: [...preset.steps] } : {}),
        ...(preset.volumeSteps ? { volumeSteps: [...preset.volumeSteps] } : {}),
        ...(preset.pitchSteps ? { pitchSteps: [...preset.pitchSteps] } : {}),
      };
    }

    function peakDb(channels) {
      let peak = 0;
      for (const channel of channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
      return peak > 1e-12 ? 20 * Math.log10(peak) : -120;
    }

    async function prepareContext() {
      const ctx = new OfflineAudioContext(2, Math.ceil(SR * RENDER_SECONDS), SR);
      await worklets.loadCoreWorklets(ctx);
      for (const type of neededTypes) {
        if ((worklets.PLUGIN_WORKLET_TYPES).includes(type)) await worklets.loadPluginWorklet(ctx, type);
        if (registry.WORKLET_EFFECTS[type] && !worklets.isWorkletReady(type, ctx)) {
          throw new Error(`Required worklet ${type} did not load`);
        }
      }
      return ctx;
    }

    async function renderChain(chainPresets, probeName, trims = []) {
      const ctx = await prepareContext();
      const sourceBuffer = ctx.createBuffer(2, SR * LOOP_SECONDS, SR);
      const probe = probeBuffer(probeName);
      sourceBuffer.copyToChannel(probe.left, 0);
      sourceBuffer.copyToChannel(probe.right, 1);
      const source = ctx.createBufferSource();
      source.buffer = sourceBuffer;
      const runtimes = [];
      let head = source;
      try {
        for (let index = 0; index < chainPresets.length; index++) {
          const preset = chainPresets[index];
          const instance = makeInstance(preset, probeName);
          const runtime = registry.EFFECT_DEFS[preset.type].factory(ctx, instance, {
            bpm: 120,
            seed: rng.hashString(`fx-reference-v1|${preset.id}|${probeName}`),
          });
          runtimes.push(runtime);
          const trim = ctx.createGain();
          trim.gain.value = Math.pow(10, (trims[index] ?? 0) / 20);
          head.connect(runtime.input);
          runtime.output.connect(trim);
          head = trim;
        }
        head.connect(ctx.destination);
        source.start(0);
        source.stop(LOOP_SECONDS);
        const buffer = await ctx.startRendering();
        const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
        const reading = meter.analyzeLoudnessBuffer(channels, SR);
        return { lufs: reading.integrated, measured: reading.measured, peakDb: peakDb(channels) };
      } finally {
        for (const runtime of runtimes) {
          try { runtime.dispose(); } catch { /* render already finished */ }
        }
      }
    }

    async function renderDry(probeName) {
      return renderChain([], probeName);
    }

    const dry = {};
    for (const probe of probeNames) dry[probe] = await renderDry(probe);

    const measurements = [];
    for (let index = 0; index < corePresets.length; index++) {
      const preset = corePresets[index];
      const readings = [];
      for (const probe of probeNames) {
        readings.push(await renderChain([preset], probe));
      }
      const valid = readings.filter((reading) => reading.measured && Number.isFinite(reading.lufs) && reading.lufs > -70);
      const loudness = valid.map((reading) => reading.lufs).sort((a, b) => a - b);
      const median = loudness.length ? loudness[Math.floor(loudness.length / 2)] : null;
      const peaks = valid.map((reading) => reading.peakDb);
      measurements.push({ id: preset.id, type: preset.type, lufs: median, peakDb: peaks.length ? Math.max(...peaks) : -120 });
      if ((index + 1) % 10 === 0 || index + 1 === corePresets.length) {
        console.log(`measured ${index + 1}/${corePresets.length} FX presets`);
      }
    }

    function medianOf(values) {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }
    function safeTrim(targetLufs, measuredLufs, peak) {
      if (!Number.isFinite(targetLufs) || !Number.isFinite(measuredLufs)) return 0;
      const desired = targetLufs - measuredLufs;
      const peakLimit = PEAK_CEILING_DB - peak;
      return Math.round(Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, peakLimit, desired)) * 10) / 10;
    }

    const typeTargets = {};
    for (const type of new Set(measurements.map((entry) => entry.type))) {
      const values = measurements.filter((entry) => entry.type === type && entry.lufs !== null).map((entry) => entry.lufs);
      if (values.length) typeTargets[type] = Math.round(medianOf(values) * 10) / 10;
    }
    const presetGains = {};
    const presetTargets = {};
    for (const entry of measurements) {
      const target = typeTargets[entry.type];
      presetTargets[entry.id] = entry.lufs === null ? null : Math.round(entry.lufs * 10) / 10;
      presetGains[entry.id] = safeTrim(target, entry.lufs, entry.peakDb);
    }
    const unsafePresets = measurements
      .filter((entry) => entry.peakDb + presetGains[entry.id] > PEAK_CEILING_DB + 0.05)
      .map((entry) => ({ id: entry.id, peakAfterTrim: Math.round((entry.peakDb + presetGains[entry.id]) * 10) / 10 }));

    const chainProbe = {
      "808-harmonics": "harmonic",
      "kick-punch": "drums",
      "drum-glue": "drums",
      "vocal-chop": "voice",
      "hat-space": "drums",
      "dusty-loop": "harmonic",
    };
    const chainGains = {};
    const chainTargets = {};
    const unsafeChains = [];
    for (const chain of chains.BEATMAKING_EFFECT_CHAINS) {
      const probe = chainProbe[chain.id] ?? "drums";
      const items = chain.effects.map((item) => {
        const preset = presetById.get(item.presetId);
        if (!preset || preset.type !== item.type) throw new Error(`Missing chain preset ${item.presetId}`);
        return preset;
      });
      const trims = items.map((preset) => presetGains[preset.id] ?? 0);
      const output = await renderChain(items, probe, trims);
      const target = dry[probe].lufs;
      chainTargets[chain.id] = output.measured ? Math.round(target * 10) / 10 : null;
      chainGains[chain.id] = output.measured ? safeTrim(target, output.lufs, output.peakDb) : 0;
      if (output.measured && output.peakDb + chainGains[chain.id] > PEAK_CEILING_DB + 0.05) {
        unsafeChains.push({
          id: chain.id,
          peakAfterTrim: Math.round((output.peakDb + chainGains[chain.id]) * 10) / 10,
        });
      }
    }

    return {
      presetGains,
      presetTargets,
      typeTargets,
      chainGains,
      chainTargets,
      unsafePresets,
      unsafeChains,
      unmeasured: measurements.filter((entry) => entry.lufs === null).map((entry) => entry.id),
    };
  });

  const entries = (record, precision = 1) => Object.entries(record)
    .filter(([, value]) => value !== null && Number.isFinite(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => `  ${JSON.stringify(id)}: ${Number(value).toFixed(precision)},`);
  const file = `/**
 * GENERATED by scripts/measure-fx-preset-loudness.mjs — do not edit by hand.
 * Probe: deterministic two-bar drum, harmonic and voice-like loops at 120 BPM,
 * rendered through the real effect factories at 44.1 kHz. Preset targets are
 * medians within effect type; chain trims match their use-case probe to dry.
 * Output is peak-safe to -1 dBFS on the measured references, clamped to
 * ${GAIN_MIN_DB}…+${GAIN_MAX_DB} dB. Static trims remain source-dependent.
 */
export const FACTORY_FX_PRESET_GAIN_DB: Record<string, number> = {
${entries(result.presetGains).join("\n")}
};

export const FACTORY_FX_PRESET_TARGET_LUFS: Record<string, number> = {
${entries(result.presetTargets).join("\n")}
};

export const FACTORY_FX_TYPE_TARGET_LUFS: Record<string, number> = {
${entries(result.typeTargets).join("\n")}
};

export const FACTORY_FX_CHAIN_GAIN_DB: Record<string, number> = {
${entries(result.chainGains).join("\n")}
};

export const FACTORY_FX_CHAIN_TARGET_LUFS: Record<string, number> = {
${entries(result.chainTargets).join("\n")}
};
`;
  writeFileSync(outFile, file, "utf8");
  console.log(`[fx-loudness] wrote ${outFile}`);
  console.log(`[fx-loudness] ${Object.keys(result.presetGains).length} presets, ${Object.keys(result.chainGains).length} chains`);
  if (result.unmeasured.length) console.warn(`[fx-loudness] unmeasured (left at 0 dB): ${result.unmeasured.join(", ")}`);
  if (result.unsafePresets.length) console.warn(`[fx-loudness] preset peaks still above -1 dBFS: ${JSON.stringify(result.unsafePresets)}`);
  if (result.unsafeChains.length) console.warn(`[fx-loudness] chain peaks still above -1 dBFS: ${JSON.stringify(result.unsafeChains)}`);
} finally {
  await browser.close();
  await server.close();
}
