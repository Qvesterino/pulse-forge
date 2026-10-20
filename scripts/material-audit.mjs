// material-audit.mjs — census the surfaces, then GATE that the material layer
// actually applies to them.
//
// WHY THIS EXISTS
// ---------------
// Wave 3 taught the same lesson twice: a whole-shell average cannot see a rule
// that silently did nothing, and a change justified by a real measurement can
// still rest on a wrong conclusion. Wave 4 (bevel) is the change that decides
// whether KYX reads as hardware or as a web dashboard, so it gets the same
// treatment: find out what the surfaces actually ARE before deciding which of
// them get the material, and keep a gate that can see a dead rule.
//
// WHAT COUNTS AS A SURFACE HERE
// -----------------------------
//   raised        visible border (>=1px on any side) AND a non-transparent fill
//   wireframe     visible border but NO fill  -> reads as "web form control"
//   fillonly      fill but NO border          -> reads as "flat swatch"
//
// The three-way split is the point: "add a bevel everywhere" and "add a bevel
// to the right 40 of them" look identical in a screenshot and behave nothing
// alike at 538 sample rows.
//
// Exit codes match scripts/typography-audit.mjs:
//   0 = census ran and every declared surface took the material
//   1 = a declared surface did not apply it
//   2 = HARNESS_ERROR — nothing was measured
import { chromium } from "playwright";
import { bootStudio } from "./lib/studio-boot.mjs";

const EXIT_GATE = 1;
const EXIT_HARNESS_ERROR = 2;
process.on("uncaughtException", (err) => {
  console.error("HARNESS_ERROR (not a gate result - nothing was measured):", err);
  process.exit(EXIT_HARNESS_ERROR);
});

const URL = process.argv[2] ?? process.env.KYX_URL ?? "http://127.0.0.1:5173";

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultNavigationTimeout(300_000);
page.setDefaultTimeout(300_000);
// ONE boot, shared with every other gate (scripts/lib/studio-boot.mjs).
// This script used to carry its own copy, and its copy was the one that
// broke: it waited for `button.pb-template-start`, a class that commit 8d11f16b
// removed from the markup. The template now lives in a CLOSED <details>, so
// the button is in the DOM but not visible. The helper opens the disclosure
// first and refuses to measure a boot that did not settle.
await bootStudio(page, URL);

// The wave-4 family. This sheet owns these four; the material must apply.
// Roles whose highlight is a SELECTION signal (.track-tab, .row-pad,
// .track-header-name, .pattern-chip) are deliberately absent — see
// 59-material-bevel.css.
const GATED_ROLES = [
  { role: "base button", selector: ".btn", expect: 0.1 },
  { role: "small button", selector: ".btn-small", expect: 0.1 },
  { role: "dock tab", selector: ".dock-tab", expect: 0.1 },
  { role: "preset filter chip", selector: ".preset-chip", expect: 0.1 },
];

const CANDIDATE_ROLES = [
  ".btn",
  ".btn-small",
  ".dock-tab",
  ".preset-chip",
  ".track-tab",
  ".row-pad",
  ".track-header-name",
  ".pattern-chip",
];

const census = await page.evaluate((candidates) => {
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const shell = document.querySelector(".app") ?? document.body;
  const kinds = { raised: 0, wireframe: 0, fillonly: 0 };
  const byRole = new Map();
  const highlightAlpha = new Map();
  const shadowShapes = new Map();
  const vh = window.innerHeight;

  // Computed style normalises box-shadow to <color> <x> <y> <blur> <spread>
  // [inset] — inset goes LAST. The first parser here assumed "inset 0px 1px 0"
  // order, matched nothing, and printed "none found" while 196 surfaces were
  // carrying a real bevel.
  const topHi = (shadow) => {
    if (!shadow || shadow === "none") return null;
    for (const part of shadow.split(/,(?![^(]*\))/)) {
      if (!/\binset\b/.test(part)) continue;
      const lens = part.match(/(-?\d*\.?\d+)px/g) || [];
      if (lens.length >= 2 && Math.round(parseFloat(lens[1])) === 1) {
        const c = part.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/);
        return c ? c[0] : null;
      }
    }
    return null;
  };

  const alphaOf = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return 0;
    const parts = m[1].split(",").map((x) => parseFloat(x));
    if (parts.length < 4) return 1;
    return Number.isFinite(parts[3]) ? parts[3] : 1;
  };

  // Per-candidate recipe: what the wave-4 family resolves to TODAY, so the
  // tokens in 59-material-bevel.css are chosen from measurement, not taste.
  const roles = {};
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) {
      roles[sel] = { present: false };
      continue;
    }
    const cs = getComputedStyle(el);
    const hi = topHi(cs.boxShadow);
    const b = el.getBoundingClientRect();
    roles[sel] = {
      present: true,
      visible: b.height > 0 && cs.display !== "none",
      shadow: (cs.boxShadow || "none").replace(/\s+/g, " "),
      highlightAlpha: hi ? Math.round(alphaOf(hi) * 1000) / 1000 : null,
      bg: cs.backgroundColor,
      text: (el.textContent || "").trim().slice(0, 18),
    };
  }

  for (const el of shell.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.width < 4) continue;

    const hasFill = alphaOf(cs.backgroundColor) > 0.02 || (cs.backgroundImage && cs.backgroundImage !== "none");
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth]
      .map(parseFloat)
      .filter((w) => w > 0.5).length;
    const hasBorder = bw > 0;
    if (!hasFill && !hasBorder) continue;

    const kind = hasBorder && hasFill ? "raised" : hasBorder ? "wireframe" : "fillonly";
    kinds[kind] += 1;

    const cls = (el.getAttribute("class") || "").trim().split(/\s+/)[0] || "";
    const key = `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
    if (!byRole.has(kind)) byRole.set(kind, new Map());
    const m = byRole.get(kind);
    if (!m.has(key)) {
      m.set(key, {
        count: 0,
        onScreen: 0,
        area: 0,
        hasShadow: cs.boxShadow && cs.boxShadow !== "none",
        shadowRecipe: (cs.boxShadow || "none").replace(/\s+/g, " ").slice(0, 120),
        sampleBg: cs.backgroundColor,
        sampleBorder: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        sampleText: (el.textContent || "").trim().slice(0, 18),
      });
    }
    // How strong is the existing top highlight, if there is one? "The shell has
    // no material" and "the material is there at 6% alpha" look identical in a
    // screenshot and need completely different fixes.
    //
    // Computed style normalises the shadow to <color> <x> <y> <blur> <spread>
    // [inset] — inset goes LAST. The first version of this parser assumed
    // "inset 0px 1px 0" order, matched nothing, and printed "none found" while
    // 196 surfaces were carrying a real bevel. A probe's negative result is a
    // claim about the world, not about the absence of an exception.
    const topHi = (shadow) => {
      if (!shadow || shadow === "none") return null;
      for (const part of shadow.split(/,(?![^(]*\))/)) {
        if (!/\binset\b/.test(part)) continue;
        const lens = part.match(/(-?\d*\.?\d+)px/g) || [];
        if (lens.length >= 2 && Math.round(parseFloat(lens[1])) === 1) {
          const c = part.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/);
          return c ? c[0] : null;
        }
      }
      return null;
    };
    const hiColor = topHi(cs.boxShadow);
    if (hiColor) bump(highlightAlpha, hiColor);
    else if (cs.boxShadow && cs.boxShadow !== "none") bump(shadowShapes, (cs.boxShadow || "").replace(/\s+/g, " ").slice(0, 90));
    const rec = m.get(key);
    rec.count += 1;
    // "onScreen" = actually inside the viewport a user is looking at. A
    // surface below the fold is real but it is not what shapes first
    // impression, and 538 catalogue rows must not outvote the visible shell.
    if (r.top < vh && r.bottom > 0) rec.onScreen += 1;
    rec.area += Math.round(r.width * r.height);
  }

  const rank = (m) =>
    Object.fromEntries(
      [...m.entries()]
        .sort((a, b) => b[1].onScreen - a[1].onScreen || b[1].area - a[1].area)
        .slice(0, 14)
        .map(([k, v]) => [k, v]),
    );

  return {
    counts: kinds,
    raised: rank(byRole.get("raised") ?? new Map()),
    wireframe: rank(byRole.get("wireframe") ?? new Map()),
    fillonly: rank(byRole.get("fillonly") ?? new Map()),
    roles,
    topHighlightAlpha: Object.fromEntries([...highlightAlpha.entries()].sort((a, b) => b[1] - a[1])),
    otherShadowRecipes: Object.fromEntries([...shadowShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)),
  };
}, CANDIDATE_ROLES);

console.log("=== surface census (1440x900, House Beat) ===");
console.log("\n--- wave-4 candidate roles: current recipe ---");
for (const [sel, r] of Object.entries(census.roles)) {
  if (!r.present) {
    console.log(`  ${sel.padEnd(24)} ABSENT in this state`);
    continue;
  }
  console.log(
    `  ${sel.padEnd(24)} topLight=${String(r.highlightAlpha ?? "none").padEnd(7)} ` +
      `visible=${r.visible ? "y" : "n"}  text="${r.text}"`,
  );
  console.log(`  ${" ".repeat(24)} ${r.shadow}`);
}
console.log(
  `  raised (border + fill) ${census.counts.raised}   ` +
    `wireframe (border only) ${census.counts.wireframe}   fillonly ${census.counts.fillonly}\n`,
);
console.log("--- existing top highlight (the bevel, if any) ---");
const hi = Object.entries(census.topHighlightAlpha);
if (!hi.length) console.log("  none found — no raised surface carries a 1px inset top light");
for (const [alpha, n] of hi) console.log(`  ${alpha.padEnd(24)} ${n} surfaces`);
console.log("\n--- other shadow recipes (no measurable top light) ---");
for (const [shape, n] of Object.entries(census.otherShadowRecipes)) console.log(`  x${String(n).padStart(4)}  ${shape}`);
console.log("");
for (const [kind, table] of [
  ["RAISED", census.raised],
  ["WIREFRAME (reads as web)", census.wireframe],
  ["FILL ONLY", census.fillonly],
]) {
  const rows = Object.entries(table);
  if (!rows.length) continue;
  console.log(`--- ${kind} ---`);
  for (const [key, v] of rows) {
    console.log(
      `  ${key.padEnd(30)} n=${String(v.count).padStart(4)} onScreen=${String(v.onScreen).padStart(4)} ` +
        `area=${String(v.area).padStart(8)} shadow=${v.hasShadow ? "y" : "n"}  bg=${v.sampleBg}`,
    );
    console.log(`  ${" ".repeat(30)} text="${v.sampleText}"`);
  }
  console.log("");
}

console.log("\n--- wave-4 gate: declared roles must resolve to the token ---\n");
let failed = 0;
for (const g of GATED_ROLES) {
  const r = census.roles[g.selector];
  const got = r?.highlightAlpha ?? null;
  const ok = r?.present === true && r.visible === true && got === g.expect;
  if (ok) {
    console.log(`  PASS  ${g.role.padEnd(22)} ${g.selector.padEnd(16)} top light ${got}`);
  } else {
    failed += 1;
    const why =
      r?.present !== true
        ? "selector does not exist in this state"
        : r?.visible !== true
          ? "matched but not visible"
          : `computed ${got} but the sheet declares ${g.expect}`;
    console.log(`  FAIL  ${g.role.padEnd(22)} ${g.selector.padEnd(16)} ${why}`);
  }
}

await browser.close();
if (failed > 0) {
  console.error(`\n${failed} material role(s) FAILED`);
  process.exit(EXIT_GATE);
}
console.log("\nall material roles applied");