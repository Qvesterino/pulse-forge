/**
 * PARAM READBACK — REAL-AUDIO VERIFICATION (param wave P3 close-out).
 *
 * tests/param-readback.test.ts proves measureParamVerification with synthetic
 * buffers; nothing ever proved the measured loop against the REAL offline
 * renderer (AudioWorklet DSP, factory bank, the trap template's Lead track).
 * This script IS that proof: parse/model-build a param intent, apply it,
 * render BEFORE/AFTER through renderProject, and require the measured
 * verification the panel would show to be TRUE — a correction chip on a
 * verified ask would be a product bug, so the verifier fails on it.
 *
 * Usage: npm run verify:param-readback   (PORT env overrides 5294)
 * Exit 0 = every scenario measured in the asked direction on real DSP.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5294;

interface TargetRow {
  target: string;
  metric: string;
  before: number;
  after: number;
  deltaPct: number;
  passed: boolean;
}

interface Verification {
  role: string;
  measurable: boolean;
  targets: TargetRow[];
  verified: boolean;
  line: string;
  correction: string | null;
}

interface ScenarioResult {
  label: string;
  parsed: boolean;
  role: string | null;
  mode: string | null;
  knobReadback: string | null;
  verification: Verification | null;
  verified: boolean | null;
  error: string | null;
}

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: PORT, host: "127.0.0.1", strictPort: true },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;

const isReloadRace = (error: unknown): boolean =>
  /context was destroyed|navigation|interrupted|timeout/i.test(String(error));

async function evalWithRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 5 || !isReloadRace(error)) throw error;
      console.log(`[retry] ${label} hit a Vite full reload — retrying (${attempt}/5)`);
      await page.waitForTimeout(5000);
    }
  }
}

try {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/studio`, { waitUntil: "domcontentloaded", timeout: 240_000 });
      break;
    } catch (error) {
      if (attempt >= 5 || !isReloadRace(error)) throw error;
      console.log(`[retry] goto interrupted (${attempt}/5)`);
      await page.waitForTimeout(5000);
    }
  }

  // The full battery runs in-page: every scenario gets a FRESH template clone
  // so an effect added by an earlier scenario never bleeds into the next
  // one's BEFORE render.
  const results = await evalWithRetry<ScenarioResult[]>("battery", () =>
    page.evaluate(async () => {
      const { createProjectFromTemplate } = await import("/src/project-model/templates.ts");
      const { generateFactoryBank } = await import("/src/sample-library/factory.ts");
      const { renderTrack } = await import("/src/rendering/track-renderer.ts");
      const { parseParamIntent, applyParamIntent, paramReadback, paramIntentFromModel } =
        await import("/src/intent/param-intent.ts");
      const { addEffectToTracks } = await import("/src/commands/tracks.ts");
      const { setEffectParam } = await import("/src/commands/effectParams.ts");
      const { measureParamVerification } = await import("/src/intent/param-readback.ts");

      const base = createProjectFromTemplate("trap");
      const lead = base.tracks.find((t) => t.kind === "instrument" && /lead/i.test(t.name));
      if (!lead) throw new Error("trap template lost its Lead track");
      const bank = await generateFactoryBank();
      const render = (doc: unknown, trackId: string): Promise<AudioBuffer | null> =>
        renderTrack(doc as never, trackId, bank, { mode: "pattern", sampleRate: 48000 }).catch(() => null);

      const rmsOf = (buffer: AudioBuffer): number => {
        let sum = 0;
        let count = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const data = buffer.getChannelData(channel);
          for (let index = 0; index < data.length; index += 7) {
            const value = data[index] ?? 0;
            sum += value * value;
            count++;
          }
        }
        return count > 0 ? Math.sqrt(sum / count) : 0;
      };

      const out: ScenarioResult[] = [];

      const runOne = async (
        label: string,
        effectType: string | null,
        build: () => ReturnType<typeof parseParamIntent>,
        preSet?: { paramId: string; value: number },
      ): Promise<void> => {
        const row: ScenarioResult = {
          label,
          parsed: false,
          role: null,
          mode: null,
          knobReadback: null,
          verification: null,
          verified: null,
          error: null,
        };
        out.push(row);
        try {
          let doc = createProjectFromTemplate("trap");
          // Track ids are generated per template instance — resolve THIS
          // doc's Lead, never the battery's first instance.
          const leadTrack = doc.tracks.find((t) => t.kind === "instrument" && /lead/i.test(t.name));
          if (!leadTrack) throw new Error("scenario clone lost its Lead track");
          // Pre-install the effect at DEFAULTS so the before/after renders
          // isolate the KNOB move. Measuring an add+move in one delta would
          // conflate the two (a fresh reverb's tail darkens the centroid no
          // matter what the tone knob does).
          if (effectType) doc = addEffectToTracks(doc, [leadTrack.id], effectType as never).execute(doc);
          if (effectType && preSet) {
            const instance = doc.tracks
              .find((t) => t.id === leadTrack.id)
              ?.effects.find((effect) => effect.type === effectType);
            if (!instance) throw new Error("pre-install lost the instance");
            doc = setEffectParam(doc, leadTrack.id, instance.id, preSet.paramId, preSet.value).execute(doc);
          }
          const intent = build();
          if (!intent) return;
          row.parsed = true;
          row.role = intent.role;
          row.mode = intent.mode;
          const afterDoc = applyParamIntent(doc, intent).execute(doc);
          row.knobReadback = paramReadback(doc, afterDoc, intent);
          row.verification = await measureParamVerification(doc, afterDoc, intent, render);
          row.verified = row.verification.verified;
        } catch (error) {
          row.error = String(error).slice(0, 200);
        }
      };

      // 0 — DETERMINISM CONTROL: the same doc must render identical levels,
      // or every delta below is noise and the verifier means nothing.
      {
        const a = await render(base, lead.id);
        const b = await render(base, lead.id);
        if (!a || !b) throw new Error("control render failed");
        const ra = rmsOf(a);
        const rb = rmsOf(b);
        const driftPct = ra > 0 ? (Math.abs(ra - rb) / ra) * 100 : 0;
        out.push({
          label: "control: same doc twice → identical level",
          parsed: true,
          role: "control",
          mode: null,
          knobReadback: `${ra.toFixed(6)} vs ${rb.toFixed(6)} (${driftPct.toFixed(4)} % drift)`,
          verification: null,
          verified: driftPct < 0.01,
          error: null,
        });
      }

      // 1 — MIX MORE via the MODEL seam on saturation (its mix is NOT the
      // primary knob). The default mix is already 1.0 — a "more" ask there is
      // an honest no-op — so the pre-state sits at 0.4 and the ask must lift
      // the RMS past the 3 % threshold.
      await runOne(
        "saturation mix more (model seam) → RMS up",
        "saturation",
        () => paramIntentFromModel("saturation", "mix", ["lead"], "more"),
        { paramId: "mix", value: 0.4 },
      );

      // 2 — TONE SET brighter (parser) on the SATURATION tilt, pre-set dark
      // (1200 Hz): the tilt acts on the dry path so the centroid follows the
      // ask. Reverb/delay tone is honestly unmeasured (scenario 2b).
      await runOne(
        "set saturation tone 1.2k → 12 kHz (parser) → centroid up",
        "saturation",
        () => parseParamIntent("set saturacia tone to 12000 hz na leade"),
        { paramId: "tone", value: 1200 },
      );

      // 2b — WET-PATH TONE honesty (reverb): the full-render centroid moves
      // the WRONG way when the output LP opens (mid-heavy tail mass), so the
      // measurement must DECLINE (measurable=false) instead of guessing.
      await runOne(
        "set reverb tone 1.2k → 16 kHz (parser) → honest unmeasured",
        "reverb",
        () => parseParamIntent("set reverb tone to 16000 hz na leade"),
        { paramId: "tone", value: 1200 },
      );

      // 3 — WIDTH MORE via the model seam, widener pre-installed: a longer
      // Haas push → side energy up.
      await runOne("haas width more (model seam) → stereo width up", "haasWidener", () =>
        paramIntentFromModel("haasWidener", "width", ["lead"], "more"),
      );

      // 4 — MIX LESS via the parser ("suchšia saturácia"), pre-installed:
      // drier → RMS down. Pinned the parser's suchší→LESS direction live.
      await runOne("saturation mix less (parser) → RMS down", "saturation", () =>
        parseParamIntent("suchsia saturacia na leade"),
      );

      // 5 — TIME SET (honest unmeasured) at 500 ms — 375 IS the delay
      // default, so that ask would be an honest no-op with an empty knob
      // readback. The measurement reports the role as not-measurable v1.
      await runOne("set delay time 500 ms (parser) → honest unmeasured", "delay", () =>
        parseParamIntent("set delay time to 500 ms on the 808"),
      );

      return out;
    }),
  );

  for (const row of results) {
    const detail = row.verification
      ? row.verification.targets
          .map(
            (target) =>
              `${target.metric} ${target.before.toFixed(4)}→${target.after.toFixed(4)} (${target.deltaPct} %)`,
          )
          .join(" · ")
      : row.knobReadback;
    // Measured roles must VERIFY; time/drive (and wet-path tone) have no v1
    // measurement — their promise is honesty (measurable=false, knob value
    // in the unit). Scenarios that DEMAND honesty carry it in the label.
    const honestlyUnmeasured =
      row.verification?.measurable === false &&
      (row.role === "time" || row.role === "drive" || row.label.includes("honest unmeasured"));
    const ok = row.verified === true || honestlyUnmeasured;
    console.log(
      `[param-readback] ${ok ? "OK  " : "FAIL"} ${row.label} — role=${row.role ?? "?"} · ${detail ?? "no measurement"}${
        row.verification?.line ? ` · "${row.verification.line}"` : ""
      }${row.error ? ` · ERROR ${row.error}` : ""}`,
    );
    if (!ok) failed = true;
  }

  // The time scenario must stay HONEST: measurable=false (drive/time v1) with
  // the knob value reported in the effect's own unit.
  const timeRow = results.find((row) => row.role === "time");
  if (timeRow) {
    const honest = timeRow.verification?.measurable === false && (timeRow.knobReadback ?? "").includes("500");
    console.log(
      `[param-readback] ${honest ? "OK  " : "FAIL"} time role stays honestly unmeasured, knob readback = ${timeRow.knobReadback}`,
    );
    if (!honest) failed = true;
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.error("[param-readback] FAILED — a measured readback contradicted the ask (or the control drifted)");
  process.exit(1);
}
console.log("[param-readback] PASS — the measured readback lands on real DSP renders");
