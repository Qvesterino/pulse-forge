// Throwaway probe: list every DISTINCT colour string in the shell, grouped by
// its function name, so the parser's coverage is a measured fact.
import { chromium } from "playwright";
import { bootStudio } from "../scripts/lib/studio-boot.mjs";

const URL = process.argv[2] ?? "http://127.0.0.1:5288";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultNavigationTimeout(300_000);
page.setDefaultTimeout(300_000);
await bootStudio(page, URL);
await page.locator(".btn-play").first().click({ timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(900);

const out = await page.evaluate(() => {
  const scope = document.querySelector(".app") ?? document.body;
  const byFormat = new Map();
  const note = (c) => {
    if (!c) return;
    const t = c.trim();
    if (t === "transparent" || t === "none") return;
    const m = /^([a-z]+)\(/i.exec(t);
    let key;
    if (m) key = m[1].toLowerCase();
    else if (t.startsWith("#")) key = "hex";
    else key = "named:" + t;
    if (!byFormat.has(key)) byFormat.set(key, new Map());
    const m2 = byFormat.get(key);
    m2.set(t, (m2.get(t) ?? 0) + 1);
  };

  // the playhead cell, raw
  const ph = document.querySelector(".step.playhead");
  const phRaw = ph
    ? (() => {
        const cs = getComputedStyle(ph);
        return { cls: ph.className, boxShadow: cs.boxShadow, border: cs.borderTopColor, bg: cs.backgroundColor };
      })()
    : null;

  for (const el of scope.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    for (const part of (cs.boxShadow || "").split(/,(?![^(]*\))/)) {
      const color = part.match(/rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+\([^)]*\)/i)?.[0];
      if (color) note(color);
    }
    for (const side of [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor])
      note(side);
  }

  const formats = {};
  for (const [key, m] of byFormat) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    formats[key] = { distinct: m.size, total: [...m.values()].reduce((a, b) => a + b, 0), samples: top };
  }
  return { formats, phRaw };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
