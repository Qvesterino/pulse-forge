/**
 * Phase 1 drill probe — instrument the multiTapDelay wet path.
 *
 * A) minimal doc: single synth note through multiTapDelay via renderProject
 *    (no drum track, no bank interplay) — does it still flip?
 * B) instrumented: wrap the multiTapDelay factory + ctx.createDelay to log
 *    every AudioParam write on the delay lines; diff logs across renders
 *    whose audio variants differ.
 */
import { createServer } from "vite";
import { chromium } from "playwright";

const PORT = 5285;
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });

const out = await page.evaluate(async () => {
  const schema = await import("/src/project-model/schema.ts");
  const templates = await import("/src/project-model/templates.ts");
  const commands = await import("/src/commands/commands.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const storeMod = await import("/src/store/ProjectStore.ts");
  const registry = await import("/src/effects/registry.ts");
  const bankFactory = await import("/src/sample-library/factory.ts");
  const bank = await bankFactory.generateFactoryBank();

  // ---- A) minimal doc: house template minus everything but one instrument track
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
  const add = commands.addEffect(st.getDoc(), instId, "multiTapDelay");
  st.execute(add);
  st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "feedback", 0));
  st.execute(commands.setEffectParam(st.getDoc(), instId, add.effectId, "taps", 1));
  const minDoc = st.getDoc();

  const rmsOf = (buf) => {
    const d = buf.getChannelData(0);
    let s = 0;
    for (let i = Math.floor(d.length / 8); i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, d.length - Math.floor(d.length / 8)));
  };
  const firstDiff = (a, b) => {
    const da = a.getChannelData(0);
    const db = b.getChannelData(0);
    for (let i = 0; i < Math.min(da.length, db.length); i++) if (Math.abs(da[i] - db[i]) > 1e-6) return i;
    return da.length === db.length ? -1 : Math.min(da.length, db.length);
  };

  const renderMin = () => renderer.renderProject(minDoc, bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6, masterProcessing: false });
  const minStamps = [];
  const minBufs = [];
  for (let i = 0; i < 5; i++) {
    const b = await renderMin();
    minBufs.push(b);
    minStamps.push(Math.round(rmsOf(b) * 1e6) / 1e6);
  }
  const minDiffs = minBufs.slice(1).map((b) => firstDiff(minBufs[0], b));

  // ---- B) instrumented full-doc renders
  const logs = [];
  const origFactory = registry.EFFECT_DEFS.multiTapDelay.factory;
  registry.EFFECT_DEFS.multiTapDelay.factory = function (ctx, instance, env) {
    const rt = origFactory.call(this, ctx, instance, env);
    const rid = logs.length;
    const entry = { rid, sets: [], delayOps: [] };
    logs.push(entry);
    const wrap = (name) => {
      const orig = rt[name]?.bind(rt);
      if (!orig) return;
      rt[name] = (...args) => {
        entry.sets.push([name, String(args[0]), args[1], args[2] === undefined ? "-" : args[2]]);
        return orig(...args);
      };
    };
    wrap("setParameter");
    wrap("setParameterAt");
    wrap("syncBpm");
    wrap("onTransportStarted");
    const origCreateDelay = ctx.createDelay.bind(ctx);
    ctx.createDelay = (...a) => {
      const node = origCreateDelay(...a);
      const dt = node.delayTime;
      for (const m of ["setValueAtTime", "setTargetAtTime", "linearRampToValueAtTime", "cancelScheduledValues"]) {
        const o = dt[m].bind(dt);
        dt[m] = (...args) => {
          entry.delayOps.push([m, args[0], args[1]]);
          return o(...args);
        };
      }
      return node;
    };
    return rt;
  };

  const mod = await import(`/src/plugin-audit-checks.ts?bust=${Date.now()}`);
  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;
  const drumId = state.baseDoc.tracks.find((t) => t.kind === "drum").id;
  const st2 = new storeMod.ProjectStore(state.baseDoc);
  const add2 = commands.addEffect(st2.getDoc(), drumId, "multiTapDelay");
  st2.execute(add2);
  st2.execute(commands.setEffectParam(st2.getDoc(), drumId, add2.effectId, "feedback", 0));
  st2.execute(commands.setEffectParam(st2.getDoc(), drumId, add2.effectId, "taps", 1));
  const doc = st2.getDoc();
  const renderDoc = () => renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6, masterProcessing: false });

  const instStamps = [];
  const instBufs = [];
  for (let i = 0; i < 5; i++) {
    const b = await renderDoc();
    instBufs.push(b);
    instStamps.push(Math.round(rmsOf(b) * 1e6) / 1e6);
  }
  // logs: one entry per factory call; renders may rebuild — keep all
  const logSummary = logs.map((l) => ({
    rid: l.rid,
    sets: l.sets.map((s) => s.join(":")),
    delayOps: l.delayOps.map((o) => o.join("@")),
  }));
  // dedupe: do any two factory-invocation logs differ?
  const sigs = new Set(logSummary.map((l) => JSON.stringify([l.sets, l.delayOps])));
  return {
    minimal: {
      stamps: minStamps,
      lengths: minBufs.map((b) => b.length),
      diffsVsFirst: minDiffs.map((d) => (d < 0 ? "same" : (d / 44100).toFixed(4) + "s")),
    },
    instrumented: {
      stamps: instStamps,
      lengths: instBufs.map((b) => b.length),
      diffsVsFirst: instBufs.slice(1).map((b, i) => {
        const fd = firstDiff(instBufs[0], b);
        return fd < 0 ? "same" : (fd / 44100).toFixed(4) + "s";
      }),
      factoryCalls: logSummary.length,
      uniqueLogSignatures: sigs.size,
    },
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
