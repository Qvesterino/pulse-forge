/**
 * TEMPORARY PROBE v9 — where does the RESIDUAL audit noise live?
 *
 * MEASURED so far: after the deterministic-id fix, two audit PROCESSES agree to
 * 1e-10..6e-8 relative (was 25 % on pitchCorrect). Something still differs.
 *
 * Probe v4 already showed: seven consecutive renders of the SAME document in
 * the SAME process give a different checksum every time, while rms/peak/side
 * agree to 9 decimals. So the render itself is not bit-reproducible.
 *
 * This probe separates the three candidate sources:
 *   A) the BANK — generateFactoryBank() renders assets through a 4-worker
 *      pool, so the ORDER in which they land in the bank depends on worker
 *      scheduling; per-asset content is seeded, but insertion order is not;
 *   B) the RENDER — the same doc + the same bank rendered twice;
 *   C) the DOC — already fixed by deterministic ids.
 *
 *   node scripts/_probe-audit-repro9.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5300;

const server = await createServer({
  root,
  logLevel: "error",
  optimizeDeps: { entries: ["index.html"] },
  server: { port: PORT, host: "127.0.0.1", strictPort: true, hmr: false, watch: null },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/bench-stem.html`, { waitUntil: "domcontentloaded", timeout: 600000 });

const out = await page.evaluate(async () => {
  const SR = 44100;
  const ids = await import(`/src/shared/ids.ts?bust=${Date.now()}`);
  const templates = await import(`/src/project-model/templates.ts?bust=${Date.now()}`);
  const factory = await import(`/src/sample-library/factory.ts?bust=${Date.now()}`);
  const curated = await import(`/src/sample-library/curated.ts?bust=${Date.now()}`);
  const renderer = await import(`/src/rendering/renderer.ts?bust=${Date.now()}`);

  const hashBuffer = (buf) => {
    let h = 2166136261 >>> 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        h ^= Math.round(d[i] * 1e6) | 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    return h >>> 0;
  };

  const maxAbsDiff = (a, b) => {
    let max = 0;
    let differing = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > 0) differing++;
      if (d > max) max = d;
    }
    return { max, differing, n };
  };

  const rms = (d) => {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, d.length));
  };

  // ---- A) the bank -------------------------------------------------------
  const bankA = await factory.generateFactoryBank();
  const bankB = await factory.generateFactoryBank();
  const idsA = bankA.entries().map(([id]) => id);
  const idsB = bankB.entries().map(([id]) => id);
  const orderSame = idsA.length === idsB.length && idsA.every((id, i) => id === idsB[i]);
  const firstOrderDiff = idsA.findIndex((id, i) => id !== idsB[i]);
  const mapA = new Map(bankA.entries());
  const mapB = new Map(bankB.entries());
  let bankDifferingIds = 0;
  let bankMaxDiff = 0;
  let bankFirstDiffId = null;
  for (const [id, bufA] of mapA) {
    const bufB = mapB.get(id);
    if (!bufB) {
      bankDifferingIds++;
      continue;
    }
    const d = maxAbsDiff(bufA.getChannelData(0), bufB.getChannelData(0));
    if (d.max > 0) {
      bankDifferingIds++;
      if (d.max > bankMaxDiff) {
        bankMaxDiff = d.max;
        bankFirstDiffId = id;
      }
    }
  }

  // ---- the document ------------------------------------------------------
  const restoreDoc = ids.useDeterministicIds();
  ids.resetDeterministicIds(0);
  const doc = templates.createProjectFromTemplate("house");
  restoreDoc();
  const drum = doc.tracks.find((t) => t.kind === "drum");
  if (drum) drum.effects = [];

  await curated.ensureCuratedLayer(bankA);
  await curated.ensureCuratedLayer(bankB);

  const render = (bank) =>
    renderer.renderProject(doc, bank, {
      mode: "pattern",
      sampleRate: SR,
      tailSeconds: 0.6,
      masterProcessing: false,
    });

  // ---- B) same doc, same bank, rendered twice ----------------------------
  const r1 = await render(bankA);
  const r2 = await render(bankA);
  const sameBankDiff = maxAbsDiff(r1.getChannelData(0), r2.getChannelData(0));
  const rms1 = rms(r1.getChannelData(0));
  const rms2 = rms(r2.getChannelData(0));

  // ---- bank order's effect: render with the OTHER bank --------------------
  const r3 = await render(bankB);
  const otherBankDiff = maxAbsDiff(r1.getChannelData(0), r3.getChannelData(0));

  // ---- second render with the other bank (does it drift too?) -------------
  const r4 = await render(bankB);
  const otherBankTwiceDiff = maxAbsDiff(r3.getChannelData(0), r4.getChannelData(0));

  return {
    bank: {
      sizeA: mapA.size,
      sizeB: mapB.size,
      orderSame,
      firstOrderDiffIndex: firstOrderDiff,
      firstOrderDiff: firstOrderDiff >= 0 ? [idsA[firstOrderDiff], idsB[firstOrderDiff]] : null,
      differingIds: bankDifferingIds,
      maxAbsDiff: bankMaxDiff,
      firstDiffId: bankFirstDiffId,
    },
    render: {
      frames: r1.length,
      channels: r1.numberOfChannels,
      sameBank: {
        maxAbsDiff: sameBankDiff.max,
        differingSamples: sameBankDiff.differing,
        ofSamples: sameBankDiff.n,
        rmsA: rms1,
        rmsB: rms2,
        rmsRelDiff: Math.abs(rms1 - rms2) / Math.max(1e-30, rms1),
      },
      otherBank: {
        maxAbsDiff: otherBankDiff.max,
        differingSamples: otherBankDiff.differing,
        rmsRelDiff: Math.abs(rms1 - rms(r3.getChannelData(0))) / Math.max(1e-30, rms1),
      },
      otherBankTwice: {
        maxAbsDiff: otherBankTwiceDiff.max,
        differingSamples: otherBankTwiceDiff.differing,
      },
    },
  };
});

console.log(JSON.stringify(out, null, 1));

await browser.close();
await server.close();
