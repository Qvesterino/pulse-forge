import { createServer } from "vite";
import { chromium } from "playwright";
const PORT = 5337;
const server = await createServer({ root: process.cwd(), logLevel: "error", server: { port: PORT, host: "127.0.0.1", strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(120_000);
await page.goto(`http://127.0.0.1:${PORT}/__probe_blank`, { waitUntil: "commit" });
const out = await page.evaluate(async ([PORT]) => {
  const exact = await import("/src/intent/exact.ts");
  const percent = await import("/src/intent/percent.ts");
  const production = await import("/src/intent/production.ts");
  const cases = [
    // [label, module, text]
    ["abs gain: basa na −6 dB", exact, "basa na -6 dB"],
    ["abs gain EN: bass to -6 dB", exact, "set bass to -6 dB"],
    ["delta dB SK: zniz basu o 3 dB", exact, "zniz basu o 3 dB"],
    ["transpose SK: basu o 3 tony nizsie", exact, "basu o 3 tony nizsie"],
    ["transpose SK2: posun lead hore o 2 semitony", exact, "posun lead hore o 2 semitony"],
    ["percent: zvys basu o 30 percent", percent, "zvys basu o 30 percent"],
    ["percent fraction: delay o tretinu viac", percent, "delay o tretinu viac"],
    ["ratio: attack 2x", production, "attack 2x pomalsi"],
    ["swing: swing 60 percent", exact, "swing 60 percent"],
    ["len rel: o 4 takty dlhsie", exact, "o 4 takty dlhsie"],
    ["hz: cutoff na 2 kHz", production, "cutoff na 2 kHz"],
  ];
  const results = [];
  for (const [label, mod, text] of cases) {
    try {
      if (mod === exact) {
        const plan = exact.parseExactIntent ? exact.parseExactIntent(text) : exact.extractExactIntents?.(text) ?? null;
        const ops = plan?.ops ?? plan;
        results.push({ label, result: ops && ops.length >= 0 ? JSON.stringify(ops) : "null" });
      } else if (mod === percent) {
        results.push({ label, result: String(percent.parsePercent(text)) });
      } else {
        const goals = production.parseProductionIntents ? production.parseProductionIntents(text) : null;
        results.push({ label, result: goals && goals.length ? JSON.stringify(goals.map((g) => g.kind ?? g.goal)) : "none" });
      }
    } catch (e) {
      results.push({ label, error: String(e).slice(0, 80) });
    }
  }
  return results;
}, [PORT]);
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
