/**
 * Phase 1 bisect probe — cross-render two-variant alternation (P0).
 *
 * Renders the same configuration N times and prints the RMS sequence plus
 * where consecutive renders diverge. Modes isolate one variable each:
 *
 *   full        audit-style doc (multiTapDelay fb .85 taps 1), master OFF
 *   masterOn    same doc, master processing ON
 *   fb0         same doc, feedback 0
 *   bypassed    same doc, effect bypassed
 *   stockDelay  stock delay (feedback .85) instead of multi-tap
 *   reverb      reverb (mix .5) instead of multi-tap
 *   bare        hand-built delay feedback graph on a bare OfflineAudioContext
 *
 * Usage: node scripts/_p1_bisect.mjs [mode] [n]
 */
import { createServer } from "vite";
import { chromium } from "playwright";

const mode = process.argv[2] ?? "full";
const N = Number(process.argv[3] ?? 6);
const PORT = 5283;

const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });

const out = await page.evaluate(
  async ([mode, N]) => {
    const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
    await mod.auditSetup();
    const state = window.__kyxPluginAuditState;
    const schema = await import("/src/project-model/schema.ts");
    const commands = await import("/src/commands/commands.ts");
    const renderer = await import("/src/rendering/renderer.ts");
    const storeMod = await import("/src/store/ProjectStore.ts");
    const base = state.baseDoc;
    const drumId = base.tracks.find((t) => t.kind === "drum").id;

    const rmsOf = (buf) => {
      const d = buf.getChannelData(0);
      let s = 0;
      for (let i = Math.floor(d.length / 8); i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / Math.max(1, d.length - Math.floor(d.length / 8)));
    };
    const firstDiff = (a, b) => {
      const da = a.getChannelData(0);
      const db = b.getChannelData(0);
      for (let i = 0; i < Math.min(da.length, db.length); i++)
        if (Math.abs(da[i] - db[i]) > 1e-6) return i;
      return da.length === db.length ? -1 : Math.min(da.length, db.length);
    };

    const buildDoc = (fxType, params, bypassed) => {
      const st = new storeMod.ProjectStore(base);
      const add = commands.addEffect(st.getDoc(), drumId, fxType);
      st.execute(add);
      for (const p of params) st.execute(commands.setEffectParam(st.getDoc(), drumId, add.effectId, p.id, p.value));
      if (bypassed) st.execute(commands.toggleEffectBypass(st.getDoc(), drumId, add.effectId));
      return st.getDoc();
    };
    const renderDocOpts = (doc, opts) =>
      renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6, ...opts });

    const renders = [];
    const stamps = [];
    if (mode === "bare") {
      for (let i = 0; i < N; i++) {
        const ctx = new OfflineAudioContext(2, 44100 * 2, 44100);
        const input = ctx.createGain();
        const outGain = ctx.createGain();
        const delay = ctx.createDelay(8);
        delay.delayTime.value = 0.4838709677419355;
        const tone = ctx.createBiquadFilter();
        tone.type = "lowpass";
        tone.frequency.value = 4500;
        const fb = ctx.createGain();
        fb.gain.value = 0.85;
        input.connect(delay).connect(tone);
        tone.connect(fb).connect(input);
        tone.connect(outGain).connect(ctx.destination);
        input.connect(outGain);
        const src = ctx.createBufferSource();
        const buf = ctx.createBuffer(2, 44100, 44100);
        for (let k = 0; k < 44100; k++) {
          const t = k / 44100;
          const env = k < 11025 ? Math.exp((-9 * k) / 44100) : 0;
          buf.getChannelData(0)[k] = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.45 * env * Math.sin(2 * Math.PI * 52 * t);
          buf.getChannelData(1)[k] = buf.getChannelData(0)[k];
        }
        src.buffer = buf;
        src.connect(input);
        src.start(0);
        renders.push(await ctx.startRendering());
      }
    } else if (mode === "masterOn") {
      const doc = buildDoc("multiTapDelay", [{ id: "feedback", value: 0.85 }, { id: "taps", value: 1 }], false);
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, {}));
    } else if (mode === "fb0") {
      const doc = buildDoc("multiTapDelay", [{ id: "feedback", value: 0 }, { id: "taps", value: 1 }], false);
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    } else if (mode === "bypassed") {
      const doc = buildDoc("multiTapDelay", [{ id: "feedback", value: 0.85 }, { id: "taps", value: 1 }], true);
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    } else if (mode === "stockDelay") {
      const doc = buildDoc("delay", [{ id: "feedback", value: 0.85 }, { id: "mix", value: 0.4 }], false);
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    } else if (mode === "reverb") {
      const doc = buildDoc("reverb", [{ id: "mix", value: 0.5 }], false);
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    } else if (mode === "phaserFb" || mode === "haasFb") {
      const templates = await import("/src/project-model/templates.ts");
      const full = templates.createProjectFromTemplate("house");
      const keep = full.tracks.find((t) => t.kind === "instrument");
      const minimal = schema.normalizeProject({
        ...full,
        tracks: [{ ...keep, effects: [] }],
        returns: [],
        groups: full.tracks.filter((t) => t.kind === "group").map((g) => ({ ...g, effects: [] })),
        master: { ...full.master, masterGain: 1, limiterEnabled: false, clipperEnabled: false, tapeEnabled: false, msEnabled: false },
      });
      const instId = minimal.tracks[0].id;
      const st = new storeMod.ProjectStore(minimal);
      const add = commands.addEffect(st.getDoc(), instId, mode === "phaserFb" ? "phaser" : "haasWidener");
      st.execute(add);
      if (mode === "phaserFb") {
        st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "feedback", 0.9));
        st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "mix", 1));
      } else {
        st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "feedback", 0.6));
      }
      const doc = st.getDoc();
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    } else if (mode === "minBypassed" || mode === "minMix0" || mode === "minStockDelay") {
      const templates = await import("/src/project-model/templates.ts");
      const full = templates.createProjectFromTemplate("house");
      const keep = full.tracks.find((t) => t.kind === "instrument");
      const minimal = schema.normalizeProject({
        ...full,
        tracks: [{ ...keep, effects: [] }],
        returns: [],
        groups: full.tracks.filter((t) => t.kind === "group").map((g) => ({ ...g, effects: [] })),
        master: { ...full.master, masterGain: 1, limiterEnabled: false, clipperEnabled: false, tapeEnabled: false, msEnabled: false },
      });
      const instId = minimal.tracks[0].id;
      const st = new storeMod.ProjectStore(minimal);
      const fxType = mode === "minStockDelay" ? "delay" : "multiTapDelay";
      const add = commands.addEffect(st.getDoc(), instId, fxType);
      st.execute(add);
      if (mode === "minStockDelay") {
        st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "feedback", 0));
      } else {
        st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "feedback", 0));
        st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "taps", 1));
        if (mode === "minMix0") st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "mix", 0));
        if (mode === "minBypassed") st.execute(commands.toggleEffectBypass(st.getDoc(), instId, add.effectId));
      }
      const doc = st.getDoc();
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    } else {
      const doc = buildDoc("multiTapDelay", [{ id: "feedback", value: 0.85 }, { id: "taps", value: 1 }], false);
      for (let i = 0; i < N; i++) renders.push(await renderDocOpts(doc, { masterProcessing: false }));
    }

    for (const r of renders) stamps.push(Math.round(rmsOf(r) * 1e6) / 1e6);
    const uniq = [...new Set(stamps)];
    const diffs = [];
    for (let i = 1; i < renders.length; i++) {
      const fd = firstDiff(renders[0], renders[i]);
      diffs.push(fd < 0 ? "same" : (fd / 44100).toFixed(4) + "s");
    }
    return { mode, stamps, uniqueCount: uniq.length, diffsVsFirst: diffs };
  },
  [mode, N],
);

console.log(JSON.stringify(out));
await browser.close();
await server.close();
