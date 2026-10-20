// Throwaway probe: which elements carry the playhead ring, and how many?
import { chromium } from "playwright";
import { bootStudio } from "../scripts/lib/studio-boot.mjs";

const URL = process.argv[2] ?? "http://127.0.0.1:5290";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultNavigationTimeout(300_000);
page.setDefaultTimeout(300_000);
await bootStudio(page, URL);
await page.locator(".btn-play").first().click({ timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(900);

const out = await page.evaluate(() => {
  const nums = (raw) =>
    raw
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((t) => {
        const pct = t.endsWith("%");
        const v = parseFloat(pct ? t.slice(0, -1) : t);
        return pct ? v / 100 : v;
      });
  const rgbOf = (c) => {
    if (!c) return null;
    const t = c.trim();
    const m = /^rgba?\(([^)]*)\)$/i.exec(t);
    if (m) {
      const p = nums(m[1]);
      if (p.length >= 3) return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      return null;
    }
    const s = /^color\(\s*srgb(?:-linear)?\s+([^)]*)\)$/i.exec(t);
    if (s) {
      const p = nums(s[1]);
      if (p.length >= 3) return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
      return null;
    }
    const at = t.toLowerCase().indexOf("oklab");
    if (at >= 0) {
      const o = t.indexOf("(", at);
      const cl = t.indexOf(")", o);
      if (o >= 0 && cl > o) {
        const p = nums(t.slice(o + 1, cl));
        if (p.length >= 3) {
          const [L, A, B] = p;
          const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
          const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
          const s_ = L - 0.0894841775 * A - 1.291485548 * B;
          const l = l_ ** 3, mm = m_ ** 3, ss = s_ ** 3;
          const linR = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss;
          const linG = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss;
          const linB = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss;
          const gam = (x) => {
            const c = x < 0 ? 0 : x > 1 ? 1 : x;
            const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
            return Math.max(0, Math.min(255, v * 255));
          };
          return { r: gam(linR), g: gam(linG), b: gam(linB), a: p.length > 3 ? p[3] : 1 };
        }
      }
    }
    return null;
  };
  const isAccent = (c) => {
    const x = rgbOf(c);
    if (!x || x.a < 0.05) return false;
    const mx = Math.max(x.r, x.g, x.b) / 255, mn = Math.min(x.r, x.g, x.b) / 255;
    if (mx - mn < 8 / 255) return false;
    const l = (mx + mn) / 2;
    const s = l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
    return s >= 0.35;
  };

  const rings = [];
  for (const el of document.querySelectorAll(".step")) {
    const cs = getComputedStyle(el);
    for (const chunk of (cs.boxShadow || "").split(/,(?![^(]*\))/)) {
      if (!/\binset\b/.test(chunk)) continue;
      const color = chunk.match(/rgba?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)/i)?.[0];
      if (!color) continue;
      const lens = [...chunk.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => parseFloat(m[1]));
      if (lens.length < 2) continue;
      if (Math.round(lens[0]) === 0 && Math.round(lens[1]) === 0 && isAccent(color)) {
        rings.push({ cls: el.className, pad: el.getAttribute("data-pad"), step: el.getAttribute("data-step"), color });
      }
    }
  }
  const byClass = {};
  for (const r of rings) {
    const k = r.cls.replace(/step active beat-start/, "step active").replace(/step playhead/, "step playhead");
    byClass[k] = (byClass[k] ?? 0) + 1;
  }
  return {
    stepCount: document.querySelectorAll(".step").length,
    playheadClassCount: document.querySelectorAll(".step.playhead").length,
    ringCount: rings.length,
    byClass,
    sample: rings.slice(0, 4),
    stepIndexes: [...new Set(rings.map((r) => r.step))],
    padIndexes: [...new Set(rings.map((r) => r.pad))].length,
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
