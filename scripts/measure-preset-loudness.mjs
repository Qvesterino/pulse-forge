/**
 * Preset loudness measurement (factory-content pass).
 *
 * Renders EVERY factory preset through the exact probe path the audition
 * audit uses (probe note 60 @ 0.82 velocity, 0.78 headroom gain, note length
 * from previewNoteDuration) in a headless Chromium, measures each render with
 * the shared BS.1770-4 analyzer (src/audio-engine/kweighting.ts) and writes
 * src/presets/preset-loudness.generated.ts: the population-median loudness
 * target plus a clamped per-preset normalization gain.
 *
 * The engine applies these gains wherever an instrument chain is built, so
 * preset browsing and application land at a consistent loudness.
 *
 * Usage: npm run presets:loudness   (PORT=5237 npm run presets:loudness)
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5237;
const outFile = path.join(root, "src", "presets", "preset-loudness.generated.ts");
/** Hard clamp mirrored by src/presets/normalization.ts. */
const GAIN_DB_LIMIT = 18;

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

const measurements = await page.evaluate(async () => {
  const registry = await import("/src/instruments/registry.ts");
  const presets = await import("/src/presets/factory.ts");
  const catalog = await import("/src/presets/catalog.ts");
  const factory = await import("/src/sample-library/factory.ts");
  const curated = await import("/src/sample-library/curated.ts");
  const quality = await import("/src/presets/audioQuality.ts");
  const loudness = await import("/src/audio-engine/kweighting.ts");

  const SR = 44100;
  // Measure on the bank the app actually plays: synth kit + curated layer.
  // Sampler/texture/vocalchop presets probe through curated overrides, so the
  // map must describe the curated sound, not the raw synth fallback.
  const bank = await factory.generateFactoryBank();
  await curated.loadCuratedLayer(bank);
  const out = [];

  for (const preset of presets.FACTORY_PRESETS) {
    const useCase = catalog.getPresetMetadata(preset).useCase;
    const track = {
      // MUST match the audit probe id (browser-checks auditFactoryPresetAudio):
      // noise-driven synths seed their streams from the track id, so a
      // different id would measure a different (equally valid) realization.
      id: `factory-preview-${preset.id}`,
      kind: "instrument",
      instrument: preset.instrument,
      name: preset.name,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      sampleId: preset.sampleId ?? null,
      params: { ...registry.defaultInstrumentParams(preset.instrument), ...preset.params },
      effects: [],
      sends: {},
      presetId: preset.id,
    };
    const durationSec = quality.previewNoteDuration(track.params);
    // One-pole band split for tonal tilt (low ≤220 Hz vs high ≥4 kHz) —
    // the reference-mastering measurement alongside loudness (sound-quality
    // pass): tiltDb > 0 = low-heavy, < 0 = bright.
    const tiltOf = (channels, sr) => {
      const lpCoef = 1 - Math.exp((-2 * Math.PI * 220) / sr);
      const hpCoef = Math.exp((-2 * Math.PI * 4000) / sr);
      let lowE = 0;
      let highE = 0;
      for (const ch of channels) {
        let lp = 0;
        let hpY = 0;
        let xPrev = 0;
        for (let i = 0; i < ch.length; i++) {
          const x = ch[i];
          lp += (x - lp) * lpCoef;
          const hp = hpCoef * (hpY + x - xPrev);
          xPrev = x;
          hpY = hp;
          lowE += lp * lp;
          highE += hp * hp;
        }
      }
      return 10 * Math.log10((lowE + 1e-12) / (highE + 1e-12));
    };
    // Chaos-driven synths (texture motion/chaos/drift) scatter between
    // renders — measure each preset THREE times and take the median so the
    // recorded loudness is stable run-to-run.
    const readings = [];
    const tiltReadings = [];
    let peak = 0;
    for (let pass = 0; pass < 3; pass++) {
      const ctx = new OfflineAudioContext(2, Math.ceil(SR * (durationSec + 0.25)), SR);
      const previewGain = ctx.createGain();
      previewGain.gain.value = 0.78;
      let runtime = null;
      try {
        runtime = registry.INSTRUMENT_DEFS[preset.instrument].factory(ctx, track, {
          bpm: 124,
          getSample: (id) => bank.get(id),
        });
        runtime.output.connect(previewGain).connect(ctx.destination);
        runtime.noteOn(60, 0.82, 0.01, durationSec);
        const buffer = await ctx.startRendering();
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
        readings.push(loudness.analyzeLoudnessBuffer(channels, SR));
        tiltReadings.push(tiltOf(channels, SR));
        const metrics = quality.measurePreviewAudio(channels);
        peak = Math.max(peak, metrics.peak);
      } finally {
        try {
          runtime?.dispose();
        } catch {
          /* already disposed */
        }
      }
    }
    if (readings.length > 0) {
      const sorted = readings.map((r) => r.integrated).sort((a, b) => a - b);
      const median = readings.find((r) => r.integrated === sorted[Math.floor(sorted.length / 2)]) ?? readings[0];
      const spread = sorted[sorted.length - 1] - sorted[0];
      const tiltSorted = [...tiltReadings].sort((a, b) => a - b);
      const tilt = tiltSorted[Math.floor(tiltSorted.length / 2)];
      // Punch = peak-to-loudness ratio (crest): how much transient headroom
      // the family carries above its average level.
      const punchPlr = peak > 1e-6 ? 20 * Math.log10(peak) - median.integrated : 0;
      out.push({
        id: preset.id,
        useCase,
        measured: median.measured === true,
        integrated: median.integrated,
        shortTermMax: median.shortTermMax,
        peak,
        punchPlrDb: Math.round(punchPlr * 10) / 10,
        tiltDb: Math.round(tilt * 10) / 10,
        spread: Math.round(spread * 10) / 10,
      });
    } else {
      out.push({ id: preset.id, useCase, measured: false, error: "all renders failed" });
    }
  }
  return out;
});

await browser.close();
await server.close();

const measured = measurements.filter((m) => m.measured);
if (measured.length === 0) {
  console.error("[preset-loudness] no preset produced a measurable render");
  process.exit(1);
}

// Per-useCase-family targets: one global target would fight the instrument
// families (an 808 sub and an airy pad measure many dB apart under K-
// weighting BY DESIGN). Consistency is enforced WITHIN a family — "all 808s
// equally loud, all pads equally loud" — while the family targets keep the
// relative balance bass > pads etc. that a mix expects.
const medianOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const familyTargets = {};
for (const useCase of new Set(measured.map((m) => m.useCase))) {
  familyTargets[useCase] = Math.round(medianOf(measured.filter((m) => m.useCase === useCase).map((m) => m.integrated)) * 10) / 10;
}

// Reference-mastering map (sound-quality pass): per family the measured
// integrated loudness, punch (PLR) and tonal tilt — consumed by the intent
// mix chain so "sound like genre X" rides on measured content, not magic.
const familyReference = {};
for (const useCase of new Set(measured.map((m) => m.useCase))) {
  const inFamily = measured.filter((m) => m.useCase === useCase);
  familyReference[useCase] = {
    integrated: familyTargets[useCase],
    punchPlrDb: Math.round(medianOf(inFamily.map((m) => m.punchPlrDb)) * 10) / 10,
    tiltDb: Math.round(medianOf(inFamily.map((m) => m.tiltDb)) * 10) / 10,
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const entries = measured
  .map((m) => {
    const target = familyTargets[m.useCase];
    const gain = Math.max(-GAIN_DB_LIMIT, Math.min(GAIN_DB_LIMIT, Math.round((target - m.integrated) * 10) / 10));
    return { id: m.id, gain, integrated: round1(m.integrated), peak: m.peak };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const unmeasured = measurements.filter((m) => !m.measured).map((m) => m.id);
// A probe at or below -70 LUFS auditions as silence: those presets need a
// content fix (their audition produces no signal), not normalization gain.
// They are clamped like everything else (boosting silence is harmless) and
// listed so the content pass can find them.
const silent = measured.filter((m) => m.integrated <= -70).map((m) => m.id);
// Presets whose 3 probe renders scatter beyond ±0.75 LU are order-dependent
// (their engine is not yet render-deterministic) — the drift gate skips them.
const nondeterministic = measured.filter((m) => (m.spread ?? 0) > 1.5).map((m) => m.id);
const lines = entries.map((e) => `  "${e.id}": ${e.gain.toFixed(1)},`);
const loudnessLines = entries.map((e) => `  "${e.id}": ${e.integrated.toFixed(1)},`);
const targetLines = Object.entries(familyTargets)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([useCase, value]) => `  ${useCase}: ${value.toFixed(1)},`);

const file = `/**
 * GENERATED by scripts/measure-preset-loudness.mjs — do not edit by hand.
 * Re-run \`npm run presets:loudness\` after adding or changing factory presets.
 *
 * Probe: note 60 @ 0.82 velocity through the preset's real instrument
 * factory at 0.78 headroom; loudness via the shared BS.1770-4 analyzer.
 * Targets are per use-case family (population median within the family):
 *
${targetLines.map((line) => ` *   ${line}`).join("\n")}
 *
 * Gains are clamped to ±${GAIN_DB_LIMIT} dB by src/presets/normalization.ts.
 */

export const PRESET_LOUDNESS_TARGET_LUFS: Record<string, number> = {
${targetLines.join("\n")}
};

export const FACTORY_PRESET_LOUDNESS: Record<string, number> = {
${loudnessLines.join("\n")}
};

/** Probe renders scatter beyond ±0.75 LU — engines not yet render-deterministic. */
export const NON_DETERMINISTIC_PRESETS: readonly string[] = [
${nondeterministic.map((id) => `  "${id}",`).join("\n")}
];

export const FACTORY_PRESET_GAIN_DB: Record<string, number> = {
${lines.join("\n")}
};

/**
 * Per-family measured reference (sound-quality pass): integrated LUFS,
 * punch (peak-to-loudness ratio, dB) and tonal tilt (10·log10(low≤220Hz /
 * high≥4kHz), dB — positive = low-heavy). Probes are single presets, so
 * absolute tilt is not a mix balance; it tracks how each family's content
 * sits and adapts the mix chain when content changes.
 */
export const FAMILY_REFERENCE: Record<string, { integrated: number; punchPlrDb: number; tiltDb: number }> = {
${Object.entries(familyReference)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([useCase, ref]) => `  ${useCase}: { integrated: ${ref.integrated.toFixed(1)}, punchPlrDb: ${ref.punchPlrDb.toFixed(1)}, tiltDb: ${ref.tiltDb.toFixed(1)} },`)
  .join("\n")}
};
`;

writeFileSync(outFile, file);
const postGains = measured.map((m) => m.integrated + entries.find((e) => e.id === m.id).gain);
console.log(
  `[preset-loudness] ${entries.length} presets measured` +
    `${unmeasured.length ? ` · ${unmeasured.length} UNMEASURED (${unmeasured.slice(0, 5).join(", ")})` : ""}`,
);
for (const [useCase, target] of Object.entries(familyTargets)) {
  const inFamily = measured.filter((m) => m.useCase === useCase);
  const after = inFamily.map((m) => Math.round((m.integrated + entries.find((e) => e.id === m.id).gain) * 10) / 10);
  console.log(
    `  ${useCase.padEnd(8)} target ${String(target).padStart(6)} LUFS · n=${String(inFamily.length).padStart(3)}` +
      ` · after-norm spread ${Math.min(...after).toFixed(1)}…${Math.max(...after).toFixed(1)}`,
  );
}
if (silent.length > 0) {
  console.log(`[preset-loudness] SILENT AUDITIONS (content pass needed): ${silent.join(", ")}`);
}
if (nondeterministic.length > 0) {
  console.log(
    `[preset-loudness] NON-DETERMINISTIC engines (drift gate skips): ${nondeterministic.length} presets — ${nondeterministic.slice(0, 6).join(", ")}`,
  );
}
console.log(`[preset-loudness] wrote ${path.relative(root, outFile)}`);
