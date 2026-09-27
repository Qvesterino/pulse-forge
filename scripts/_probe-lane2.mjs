import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({ root, logLevel: "error", server: { port: 5241, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 300)));
await page.goto("http://127.0.0.1:5241/", { waitUntil: "domcontentloaded", timeout: 180_000 });
const out = await page.evaluate(async () => {
  const engineMod = await import("/src/audio-engine/AudioEngine.ts");
  window.__probeCalls = { sda: 0, wdt: 0, rtFound: 0 };
  const proto = engineMod.AudioEngine.prototype;
  if (!proto.__patched) {
    proto.__patched = true;
    const origSda = proto.scheduleDeviceAutomation;
    proto.scheduleDeviceAutomation = function (...args) {
      window.__probeCalls.sda++;
      return origSda.apply(this, args);
    };
    const origWdt = proto.writeDeviceTargetAt;
    proto.writeDeviceTargetAt = function (target, value, when) {
      window.__probeCalls.wdt++;
      const rt = this.effectRuntimeForTarget(target);
      if (rt) window.__probeCalls.rtFound++;
      return origWdt.apply(this, [target, value, when]);
    };
  }
  const mod = await import("/src/plugin-audit-checks.ts");
  await mod.auditSetup();
  const state = window.__kyxPluginAuditState;
  const schema = await import("/src/project-model/schema.ts");
  const commands = await import("/src/commands/commands.ts");
  const renderer = await import("/src/rendering/renderer.ts");
  const storeMod = await import("/src/store/ProjectStore.ts");
  const base = state.baseDoc;
  const drumId = base.tracks.find((t) => t.kind === "drum").id;
  const render = (doc) => renderer.renderProject(doc, state.bank, { mode: "pattern", sampleRate: 44100, tailSeconds: 0.6 });
  const sideOf = (buf) => { const l = buf.getChannelData(0), r = buf.getChannelData(1); let s = 0, n = 0; for (let i = Math.floor(l.length/8); i < l.length; i++) { const d = l[i]-r[i]; s += d*d; n++; } return Math.sqrt(s/n); };
  const rmsOf = (buf) => { const d = buf.getChannelData(0); let s = 0; for (let i = Math.floor(d.length/8); i < d.length; i++) s += d[i]*d[i]; return Math.sqrt(s / d.length); };
  const buildAuto = async (type, paramId, value) => {
    const st = new storeMod.ProjectStore(base);
    const add = commands.addEffect(st.getDoc(), drumId, type);
    st.execute(add);
    return schema.normalizeProject({
      ...st.getDoc(),
      automation: [{ id: "probe-lane", target: { kind: "fxParam", trackId: drumId, fxId: add.effectId, paramId }, points: [{ tick: 0, value }, { tick: 480, value }] }],
    });
  };
  const calls = window.__probeCalls;
  const phaser8 = await buildAuto("phaser", "rate", 8);
  const phaser0 = await buildAuto("phaser", "rate", 0.4);
  const lanesKept = phaser8.automation.length;
  const a = await render(phaser8);
  const b = await render(phaser0);
  const plain = await render((await buildAuto("phaser", "rate", 8))); // doc WITH lane but we render without? build plain doc:
  // plain = effect only, no lane
  const st2 = new storeMod.ProjectStore(base);
  const add2 = commands.addEffect(st2.getDoc(), drumId, "phaser");
  st2.execute(add2);
  const plainDoc = st2.getDoc();
  const p = await render(plainDoc);
  const callSnapshot = { ...window.__probeCalls };
  return {
    calls: callSnapshot,
    lanesKept,
    phaserRate8: { rms: rmsOf(a), side: sideOf(a) },
    phaserRate04: { rms: rmsOf(b), side: sideOf(b) },
    phaserPlain: { rms: rmsOf(p), side: sideOf(p) },
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
