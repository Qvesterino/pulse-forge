// Throwaway probe: run the SAME parser logic over the whole live shell and
// report what it finds, plus every colour FORMAT that occurs.
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
  const nums = (raw) =>
    raw
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((token) => {
        const pct = token.endsWith("%");
        const value = parseFloat(pct ? token.slice(0, -1) : token);
        return pct ? value / 100 : value;
      });

  const rgbOf = (color) => {
    if (!color) return null;
    const rgbMatch = /rgba?\(([^)]+)\)/i.exec(color);
    if (rgbMatch) {
      const parts = nums(rgbMatch[1]);
      if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n)))
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
      return null;
    }
    const srgbMatch = /color\(\s*srgb\s+([^)]+)\)/i.exec(color);
    if (srgbMatch) {
      const parts = nums(srgbMatch[1]);
      if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n)))
        return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
    }
    return null;
  };

  const isAccent = (color) => {
    const c = rgbOf(color);
    if (!c) return false;
    if (c.a < 0.05) return false;
    const max = Math.max(c.r, c.g, c.b) / 255;
    const min = Math.min(c.r, c.g, c.b) / 255;
    if (max - min < 8 / 255) return false;
    const l = (max + min) / 2;
    const s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
    return s >= 0.35;
  };

  const parseShadow = (shadow) => {
    if (!shadow || shadow === "none") return [];
    const out = [];
    for (const chunk of shadow.split(/,(?![^(]*\))/)) {
      const color = chunk.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)|#[0-9a-f]{3,8}/i)?.[0];
      if (!color) continue;
      const lengths = [...chunk.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => parseFloat(m[1]));
      if (lengths.length < 2) continue;
      out.push({ color, x: lengths[0] ?? 0, y: lengths[1] ?? 0, inset: /\binset\b/.test(chunk) });
    }
    return out;
  };

  const scope = document.querySelector(".app") ?? document.body;
  const formats = new Map();
  const note = (c) => {
    if (!c) return;
    const m = /^([a-z-]+)\(/i.exec(c.trim());
    const key = m ? m[1] : c.trim().startsWith("#") ? "hex" : "other";
    formats.set(key, (formats.get(key) ?? 0) + 1);
  };

  const perRole = {};
  for (const sel of [".step", ".step.active", ".step.playhead", ".pattern-chip", ".pattern-chip.active", ".ruler-tick.current", ".row-pad.selected", ".track-header-name", ".btn", ".dock-tab", ".preset-chip", ".track-tab"]) {
    const els = [...scope.querySelectorAll(sel)];
    let insetAccent = 0;
    let borderAccent = 0;
    let ring = 0;
    let topLight = 0;
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const p of parseShadow(cs.boxShadow)) {
        note(p.color);
        if (!p.inset) continue;
        if (Math.round(p.y) === 1 && Math.round(p.x) === 0) topLight += 1;
        if (Math.round(p.x) === 0 && Math.round(p.y) === 0 && isAccent(p.color)) ring += 1;
        if (isAccent(p.color)) insetAccent += 1;
      }
      for (const side of [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor]) {
        note(side);
        if (isAccent(side)) borderAccent += 1;
      }
    }
    perRole[sel] = { n: els.length, insetAccent, borderAccent, ring, topLight };
  }

  // every colour format anywhere in the shell
  for (const el of scope.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    for (const p of parseShadow(cs.boxShadow)) note(p.color);
    for (const side of [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.color, cs.backgroundColor])
      note(side);
  }

  return { perRole, formats: Object.fromEntries([...formats.entries()].sort((a, b) => b[1] - a[1])) };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
