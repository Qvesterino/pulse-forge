import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

/**
 * PARAM-WIRING PROBE — does an AudioParam write made at CONSTRUCTION reach a
 * k-rate AudioWorklet parameter inside an OfflineAudioContext?
 *
 * WHY THIS EXISTS
 * The 2026-09-27 plugin audit reports 72 parameters whose render is
 * BIT-IDENTICAL at min and max (`delta === 0`). Seven of them belong to the
 * gate: hysteresis, attack, hold, release, range, lookahead, mix — while
 * `threshold`, in the same processor with the same write path, DOES move.
 * That split is the whole clue: if the registry's write were simply missing,
 * threshold would be dead too.
 *
 * The registry writes through `safeApplyAudioParam(node, id, value, ctx.currentTime)`
 * → `setValueAtTime(value, when)`. In an OfflineAudioContext `currentTime` is 0
 * until rendering starts, so every construction-time write lands exactly ON the
 * render start, competing with the processor's descriptor defaults.
 *
 * THIS PROBE MEASURED, IT DOES NOT ASSUME. It renders the same signal five ways
 * per parameter and reports whether the output moved. Whatever the verdict, the
 * number below is the evidence — and if the two write styles agree, this whole
 * line of enquiry is closed and the gate params are dead for some OTHER reason.
 */

const root = process.cwd();
const workletPath = path.join(root, "src", "audio-worklets", "gate-processor.js");
const PORT = 0;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (pathname === "/") {
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><body></body></html>");
  } else if (pathname === "/gate-processor.js") {
    response
      .writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
      .end(await readFile(workletPath));
  } else {
    response.writeHead(404).end();
  }
});

let browser;

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("param probe did not get a local port");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });

  const result = await page.evaluate(async () => {
    const SR = 48_000;
    const FRAMES = SR * 4; // 4 s
    // A gate with the shipped defaults (hold 20 ms, release 80 ms) needs a gap
    // of ORDER SECONDS to pull its envelope below the threshold: after 220 ms
    // the one-pole envelope is still ~-30 dB, above a -36 dB threshold, so the
    // gate is CORRECTLY still open. My first burst signal had a 220 ms gap and
    // therefore measured a correctly-open gate as "does nothing".
    const BURST_PERIOD = 2.0;
    const BURST_ON = 0.3;

    /**
     * TWO signals, because the SIGNAL is the confound under test.
     *
     *  - "steady" mirrors what the plugin audit feeds every effect: a constant
     *    tone that never falls below the gate threshold. A gate that never
     *    closes cannot show hold / release / hysteresis / range — whatever is
     *    measured there is a fact about the signal, not about the wire.
     *  - "burst" is loud-then-silent, which actually exercises a gate.
     *
     * A parameter that responds under "burst" and not under "steady" is WIRED,
     * and the audit's "dead parameter" verdict for it is an artefact.
     */
    const buildSignal = (ctx, kind) => {
      const buf = ctx.createBuffer(1, FRAMES, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < FRAMES; i++) {
        const t = i / SR;
        if (kind === "steady") {
          d[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 440 * t);
        } else {
          const cycle = t % BURST_PERIOD;
          const on = cycle < BURST_ON;
          d[i] = on ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 0.0005 * Math.sin(2 * Math.PI * 900 * t);
        }
      }
      return buf;
    };

    /**
     * `dyn` (block-RMS hi/lo) was my first metric and it was WRONG for a gate:
     * a burst signal already has a huge hi/lo ratio, so a gate that stays open
     * and one that closes produce the SAME number. The gate's actual job is
     * WHEN it attenuates, so the metric has to look at the quiet gaps:
     *
     *   gateDepth = mean|loud| / mean|gap|
     *
     * A closed gate pushes this up (gaps pushed down); an open gate leaves the
     * signal's own ~1000x gap ratio alone. That is the quantity a threshold,
     * hold, range, mix or hysteresis must move.
     */
    const metrics = (buffer, kind) => {
      const l = buffer.getChannelData(0);
      const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
      let sum = 0;
      for (let i = 0; i < l.length; i++) sum += l[i] * l[i];
      const rms = Math.sqrt(sum / Math.max(1, l.length));
      let ssum = 0;
      for (let i = 0; i < l.length; i++) ssum += (l[i] - r[i]) ** 2;
      const side = Math.sqrt(ssum / l.length);
      if (kind !== "burst") return { rms, side, gateDepth: null, loudDb: null, gapDb: null };

      let loud = 0;
      let loudN = 0;
      let gap = 0;
      let gapN = 0;
      for (let i = 0; i < l.length; i++) {
        const t = i / SR;
        const phase = t % BURST_PERIOD;
        if (phase < BURST_ON) {
          loud += Math.abs(l[i]);
          loudN++;
        } else if (phase > BURST_ON + 0.4) {
          gap += Math.abs(l[i]);
          gapN++;
        }
      }
      const meanLoud = loud / Math.max(1, loudN);
      const meanGap = gap / Math.max(1, gapN);
      const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-12));
      return {
        rms,
        side,
        gateDepth: meanLoud / Math.max(meanGap, 1e-9),
        loudDb: toDb(meanLoud),
        gapDb: toDb(meanGap),
      };
    };

    const render = async (paramId, value, style, kind) => {
      const ctx = new OfflineAudioContext(2, FRAMES, SR);
      // Reference: the signal with NO node at all. If the gated render matches
      // this, the gate is passing the signal through and any "flat" reading
      // downstream is the gate's behaviour, not the measurement's.
      const src = ctx.createBufferSource();
      src.buffer = buildSignal(ctx, kind);
      if (style === "RAW") {
        src.connect(ctx.destination);
        src.start(0);
        return metrics(await ctx.startRendering(), kind);
      }
      await ctx.audioWorklet.addModule("/gate-processor.js");
      const node = new AudioWorkletNode(ctx, "gate-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
      });
      if (style !== "none") {
        const p = node.parameters.get(paramId);
        if (!p) return null; // param not declared by the processor
        if (style === "value") p.value = value;
        else if (style === "setValueAtTime@currentTime") p.setValueAtTime(value, ctx.currentTime);
        else p.setValueAtTime(value, 0.05);
      }
      src.connect(node);
      node.connect(ctx.destination);
      src.start(0);
      const out = await ctx.startRendering();
      return metrics(out, kind);
    };

    const declared = new Set();
    {
      const ctx = new OfflineAudioContext(2, 128, SR);
      await ctx.audioWorklet.addModule("/gate-processor.js");
      const probe = new AudioWorkletNode(ctx, "gate-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
      });
      for (const p of probe.parameters.keys()) declared.add(p);
    }

    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), 1e-9);
    const rows = [];
    for (const [id, value] of [
      ["threshold", -80],
      ["hold", 0.4],
      ["range", -6],
      ["mix", 0.2],
      ["attack", 0.4],
      ["hysteresis", 0.9],
      ["release", 0.9],
      ["lookahead", 0.5],
    ]) {
      if (!declared.has(id)) {
        rows.push({ param: id, declared: false });
        continue;
      }
      const row = { param: id, declared: true, value };
      // Best response over the write styles — a parameter that is wired will
      // move under at least one of them, and comparing styles is how the
      // "writes never arrive" hypothesis gets falsified rather than assumed.
      for (const kind of ["steady", "burst"]) {
        const raw = await render(id, value, "RAW", kind);
        const base = await render(id, value, "none", kind);
        const styles = {
          setValueAtCurrentTime: await render(id, value, "setValueAtTime@currentTime", kind),
          valueAssignment: await render(id, value, "value", kind),
          setValueAt0_05: await render(id, value, "setValueAtTime@0.05", kind),
        };
        row[`${kind}_baseGateDepth`] = base.gateDepth;
        row[`${kind}_rawGateDepth`] = raw.gateDepth;
        row[`${kind}_rawGapDb`] = raw.gapDb;
        row[`${kind}_baseGapDb`] = base.gapDb;
        row[`${kind}_rawLoudDb`] = raw.loudDb;
        row[`${kind}_baseLoudDb`] = base.loudDb;
        // If base === raw, the node passes the signal untouched at defaults.
        row[`${kind}_nodeAltersAtDefault`] =
          raw.gateDepth === null || base.gateDepth === null
            ? null
            : Math.abs(base.gateDepth - raw.gateDepth) / Math.max(raw.gateDepth, 1e-9) > 0.01;
        for (const [styleName, out] of Object.entries(styles)) {
          row[`${kind}_${styleName}_gateDepthDelta`] =
            out.gateDepth === null ? null : rel(out.gateDepth, base.gateDepth);
          row[`${kind}_${styleName}_rmsDelta`] = rel(out.rms, base.rms);
        }
        row[`${kind}_bestDynDelta`] = Math.max(
          ...Object.values(styles).map((out) => (out.gateDepth === null ? 0 : rel(out.gateDepth, base.gateDepth))),
        );
      }
      // THE VERDICT COLUMN: responds with a signal that exercises the device,
      // stays flat on a signal that cannot. That is a measurement artefact.
      row.auditVerdictExplained =
        row.steady_bestDynDelta <= 0.02 && row.burst_bestDynDelta > 0.02
          ? "ARTEFACT — wired; the audit's steady signal cannot trigger this parameter"
          : row.steady_bestDynDelta > 0.02
            ? "responsive under both signals"
            : "STILL FLAT — needs a look by hand";
      rows.push(row);
    }
    return { declared: [...declared].sort(), rows };
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.close();
}
