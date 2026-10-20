/**
 * TEMPORARY diagnostic — delete after use.
 *
 * Goal: replace the absolute HOST_EPS with a criterion that is relative to the
 * render's OWN noise floor, and find a metric that can see effects which
 * preserve energy (reverseSwell reorders time; RMS/peak/crest/side are
 * near-invariant to that).
 *
 * MEASURED PROBLEM with the previous probe: its "NOISE" row computed the SAME
 * comparison twice (bypassed vs on) because of a no-op ternary. So the values
 * 1.27e-5 and 2.97e-3 were NOT noise floors — they were two runs of the
 * positive case. The run-to-run difference between them IS the jitter.
 *
 * This probe renders the SAME configuration twice (genuine noise control) and
 * compares:
 *   signal = delta(engaged, bypassed)
 *   noise  = delta(engaged_render_1, engaged_render_2)
 *
 * Candidates:
 *   postAmp  current: all amplitude metrics from the post-attack window
 *   fullAmp  amplitude metrics from the whole buffer
 *   fullCorr per-segment normalized cross-correlation divergence (max segment)
 *   fullEnv  per-segment RMS-envelope divergence (max segment)
 *
 * Acceptance: signal/noise must be high for effects that DO process, and the
 * noise ratio must be ~1 for the genuine control.
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CASES = {
  reverseSwell: [["engaged", 1], ["time", 0.25]],
  reverb: [["mix", 1]],
  rezonans: [["mix", 1]],
  pitchCorrect: [["speed", 0], ["amount", 1]],
  sirka: [["midWidth", 0]],
  vocoder: [["mix", 1]],
  sidechain: [["threshold", 0]],
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 5291, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
await page.route("**/index.html", (route) =>
  route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
);

try {
  await page.goto("http://127.0.0.1:5291/", { waitUntil: "domcontentloaded", timeout: 240_000 });
  const out = await page.evaluate(async (cfg) => {
    const SR = 44100;
    const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
    const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
    const { ensureCuratedLayer } = await import("/src/sample-library/curated.ts");
    const { renderProject } = await import("/src/rendering/renderer.ts");
    const { ProjectStore } = await import("/src/store/ProjectStore.ts");
    const { addEffect, setEffectParam, toggleEffectBypass } = await import("/src/commands/commands.ts");
    const { EFFECT_META } = await import("/src/effects/definitions.ts");

    const bank = await generateFactoryBank();
    await ensureCuratedLayer(bank);
    const renderDoc = (doc) =>
      renderProject(doc, bank, { mode: "pattern", sampleRate: SR, tailSeconds: 0.6, masterProcessing: false });

    const base0 = createProjectFromTemplate("house");
    base0.tracks.find((t) => t.kind === "drum").effects = [];
    const trackId = base0.tracks.find((t) => t.kind === "drum").id;
    const clone = () => JSON.parse(JSON.stringify(base0));

    const build = async (type, params, bypass) => {
      const st = new ProjectStore(clone());
      const add = addEffect(st.getDoc(), trackId, type);
      st.execute(add);
      const defs = new Set(EFFECT_META[type].params.map((p) => p.id));
      for (const [id, v] of params) if (defs.has(id)) st.execute(setEffectParam(st.getDoc(), trackId, add.effectId, id, v));
      if (bypass) st.execute(toggleEffectBypass(st.getDoc(), trackId, add.effectId));
      return renderDoc(st.getDoc());
    };

    const ampMetrics = (buf, wide) => {
      const l = buf.getChannelData(0);
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
      const start = wide ? 0 : Math.floor(l.length / 8);
      let peak = 0;
      let sumSq = 0;
      let sideSum = 0;
      for (let i = start; i < l.length; i++) {
        const a = l[i];
        const b = r[i];
        peak = Math.max(peak, Math.abs(a), Math.abs(b));
        sumSq += a * a;
        const s = a - b;
        sideSum += s * s;
      }
      const n = Math.max(1, l.length - start);
      const rms = Math.sqrt(sumSq / n);
      return { rms, peak, crest: peak / Math.max(1e-6, rms), side: Math.sqrt(sideSum / n) };
    };
    const ampDelta = (a, b, wide) => {
      const x = ampMetrics(a, wide);
      const y = ampMetrics(b, wide);
      return Math.max(
        Math.abs(y.rms - x.rms) / Math.max(x.rms, 1e-6),
        Math.abs(y.crest - x.crest) / Math.max(x.crest, 0.2),
        Math.abs(y.side - x.side) / Math.max(x.side, x.rms * 0.1, 1e-6),
      );
    };

    // Per-segment metrics over the WHOLE buffer.
    const SEG = 16;
    const segs = (buf) => {
      const l = buf.getChannelData(0);
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
      const n = Math.floor(l.length / SEG);
      const out = [];
      for (let s = 0; s < SEG; s++) {
        let sumSq = 0;
        let sumXY = 0;
        let sumXX = 0;
        let sumYY = 0;
        for (let i = s * n; i < (s + 1) * n; i++) {
          const x = l[i];
          const y = r[i];
          sumSq += x * x;
          sumXY += x * y;
          sumXX += x * x;
          sumYY += y * y;
        }
        out.push({ rms: Math.sqrt(sumSq / Math.max(1, n)), corrDen: Math.sqrt(sumXX * sumYY), sumXY, sumXX, sumYY });
      }
      return out;
    };

    const corrDelta = (a, b) => {
      const sa = segs(a);
      const sb = segs(b);
      let best = 0;
      for (let s = 0; s < SEG; s++) {
        const den = Math.sqrt(sa[s].sumXX * sb[s].sumYY);
        if (den < 1e-9) continue; // both silent here — no information
        const corr = sa[s].sumXY / den;
        best = Math.max(best, 1 - corr);
      }
      return best;
    };

    const envDelta = (a, b) => {
      const sa = segs(a);
      const sb = segs(b);
      let best = 0;
      for (let s = 0; s < SEG; s++) {
        const d = Math.abs(sb[s].rms - sa[s].rms) / Math.max(sa[s].rms, 1e-6);
        best = Math.max(best, d);
      }
      return best;
    };

    const rows = [];
    for (const [type, params] of Object.entries(cfg.cases)) {
      const on1 = await build(type, params, false);
      const on2 = await build(type, params, false); // genuine noise control
      const bypassed = await build(type, params, true);
      const pick = (f) => ({
        signal: f(bypassed, on1),
        noise: f(on1, on2),
      });
      rows.push({
        type,
        postAmp: pick((x, y) => ampDelta(x, y, false)),
        fullAmp: pick((x, y) => ampDelta(x, y, true)),
        fullCorr: pick(corrDelta),
        fullEnv: pick(envDelta),
      });
    }
    return rows;
  }, { cases: CASES });

  console.log("effect          metric      signal       noise        ratio");
  for (const r of out) {
    for (const m of ["postAmp", "fullAmp", "fullCorr", "fullEnv"]) {
      const v = r[m];
      const ratio = v.noise > 0 ? v.signal / v.noise : v.signal > 0 ? Infinity : 0;
      const flag = ratio >= 10 ? "OK " : ratio >= 3 ? "weak" : "BLIND";
      console.log(
        r.type.padEnd(14) +
          m.padEnd(11) +
          v.signal.toExponential(3).padEnd(14) +
          v.noise.toExponential(3).padEnd(14) +
          (ratio === Infinity ? "inf" : ratio.toFixed(2)).padEnd(12) +
          flag,
      );
    }
    console.log("");
  }
  console.log("ratio = signal/noise. >=10 = separable, <3 = indistinguishable from render jitter.");
} finally {
  await browser.close();
  await server.close();
}