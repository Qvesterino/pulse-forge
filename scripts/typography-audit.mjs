// typography-audit.mjs — measure where the studio's type sits, then GATE that the
// declared roles actually took effect.
//
// WHY THIS IS A GATE AND NOT A REPORT
// -----------------------------------
// The first draft of 58-typography-scale.css had 8 rules. Measured in the live
// DOM, 2 of them changed anything: 3 restated the value that was already
// applied, 2 matched zero elements, and 1 lost the cascade to a more specific
// selector. A whole-shell average ("74.2% of text is 8-11px", down from 74.3%)
// reads like a measurement of the change and is actually a measurement of a
// scrolling sample catalogue — 806 of 1376 text nodes are one list. An average
// cannot distinguish "moved" from "never applied".
//
// So this tool asserts per role: the selector must match at least one visible
// element, and every visible match must compute to the declared size. A rule
// that matches nothing, or that is silently overridden, fails the gate.
//
// Exit codes (same contract as scripts/ui-proportion.mjs):
//   0 = every role and protected check held
//   1 = a check failed
//   2 = HARNESS_ERROR — nothing was measured; NOT a gate result
import { chromium } from "playwright";
import { bootStudio } from "./lib/studio-boot.mjs";

const EXIT_GATE = 1;
const EXIT_HARNESS_ERROR = 2;
process.on("uncaughtException", (err) => {
  console.error("HARNESS_ERROR (not a gate result - nothing was measured):", err);
  process.exit(EXIT_HARNESS_ERROR);
});

// The dock has exactly TWO slots (App.tsx: dock.slotA / dock.slotB) and a plain
// click REPLACES the focused slot — onToggle(id, ctrlKey) only keeps both when
// ctrl/meta is held. So the realistic multi-panel state is two panels, not
// "as many as there are tabs". Opening six tabs would have toggled the dock
// back down to one panel by the end and measured the wrong thing.
const TABS_TO_OPEN = 2;

// kind "role"      — this sheet owns it; a mismatch is a defect here.
// The panel-title ladder is checked separately (see PANEL_LADDER) because its
// correct shape is a RELATION between two tags, not two absolute selectors: a
// fixed `h2.panel-title` check passes or fails depending on which panel happens
// to be open, which is a harness state, not a defect.
const CHECKS = [
  { kind: "role", role: "dock tab (primary navigation)", selector: ".dock-tab", expectPx: 12 },
  { kind: "role", role: "channel name (sequencer row)", selector: ".row-pad-name", expectPx: 13 },
  { kind: "role", role: "channel name (track header)", selector: ".sequencer .track-header-name", expectPx: 13 },
  { kind: "role", role: "row index (metadata)", selector: ".row-pad-index", expectPx: 8 },
];

// The hierarchy 29-premium-hierarchy.css builds and this sheet refuses to touch.
const PANEL_LADDER = { h2: 15, h3: 12 };

// 5173 is the port `npm run dev` serves (AGENTS.md §1). Override with the first
// CLI arg or KYX_URL when a dev server is running somewhere else.
const URL = process.argv[2] ?? process.env.KYX_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultNavigationTimeout(300_000);
page.setDefaultTimeout(300_000);
await bootStudio(page, URL);

const tabs = page.locator(".dock-tab");
const tabCount = await tabs.count();
const want = Math.min(tabCount, TABS_TO_OPEN);
let opened = 0;
for (let i = 0; i < want; i += 1) {
  const t = tabs.nth(i);
  // First tab fills slot A, the rest need ctrl/meta to ADD instead of replace.
  await t.click({ timeout: 30_000, modifiers: i === 0 ? [] : ["Control"] }).catch(() => {});
  await page.waitForTimeout(600);
}
opened = await page.locator('.dock-tab[aria-expanded="true"]').count();

// A dock that did not reach two open panels is a WRONG MEASUREMENT STATE, not a
// failed gate. Reporting it as "checks failed" is the harness error this repo
// already has a scar from. Say so explicitly and exit 2.
if (want > 0 && opened < want) {
  console.error(
    `HARNESS_ERROR (not a gate result - nothing was measured): only ${opened}/${want} dock panels opened. ` +
      `The protected h2/h3 checks need a real two-panel state.`,
  );
  await browser.close();
  process.exit(EXIT_HARNESS_ERROR);
}
await page.waitForTimeout(800);

const result = await page.evaluate(
  ({ checks, ladder }) => {
    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    const top = (map, n) =>
      Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, v]));
    const pxOf = (el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10;
    const isVisible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return el.getBoundingClientRect().height > 0;
    };

    const measured = checks.map((c) => {
      const nodes = [...document.querySelectorAll(c.selector)];
      const visible = nodes.filter(isVisible);
      const sizes = new Map();
      for (const el of visible) bump(sizes, pxOf(el));
      const wrong = [...sizes.entries()].filter(([px]) => px !== c.expectPx);
      return {
        ...c,
        matched: nodes.length,
        visible: visible.length,
        sizes: Object.fromEntries([...sizes].sort((a, b) => a[0] - b[0])),
        ok: visible.length > 0 && wrong.length === 0,
        reason:
          visible.length === 0
            ? "matched nothing visible - the selector does not exist in this state"
            : wrong.length > 0
              ? `computed ${wrong.map(([px, n]) => `${px}px x${n}`).join(", ")} but the sheet declares ${c.expectPx}px`
              : "",
        sample: visible.length ? (visible[0].textContent || "").trim().slice(0, 24) : "",
      };
    });

    // Panel-title ladder: every h2 is 15px and every h3 is 12px, whichever
    // panels happen to be open. State-independent by construction.
    const titles = [...document.querySelectorAll(".panel-title")].filter(isVisible);
    const byTag = new Map();
    const ladderWrong = [];
    for (const el of titles) {
      const tag = el.tagName.toLowerCase();
      const px = pxOf(el);
      const key = `${tag}@${px}`;
      bump(byTag, key);
      if (ladder[tag] !== undefined && px !== ladder[tag]) {
        ladderWrong.push(`${tag} "${(el.textContent || "").trim().slice(0, 18)}" is ${px}px, ladder says ${ladder[tag]}px`);
      }
    }
    const ladderCheck = {
      role: "panel title ladder (h2 top, h3 local)",
      visible: titles.length,
      sizes: Object.fromEntries([...byTag].sort()),
      ok: titles.length > 0 && ladderWrong.length === 0 && ladder.h2 > ladder.h3,
      reason:
        titles.length === 0
          ? "no visible panel title at all - the dock state is wrong"
          : ladderWrong.length > 0
            ? ladderWrong.join("; ")
            : !(ladder.h2 > ladder.h3)
              ? "ladder constants are not ordered - h2 must outrank h3"
              : "",
      sample: titles.length ? (titles[0].textContent || "").trim().slice(0, 24) : "",
    };

    // Mass report: the same walk, but grouped so "where is the small text" has an
    // answer with names in it rather than one averaged percentage.
    const REGIONS = [
      ["transport", ".transport-cluster, .transport"],
      ["topbar", ".topbar"],
      ["patternBar", ".pattern-bar"],
      ["rackHeader", ".rack-header"],
      ["sequencerRow", ".sequencer-row"],
      ["sequencerChrome", ".sequencer"],
      ["dockPanels", ".bottom-panels"],
      ["statusbar", ".statusbar"],
    ];
    const regionOf = (el) => {
      for (const [name, sel] of REGIONS) if (el.closest(sel)) return name;
      return "other";
    };
    const shell = document.querySelector(".app") ?? document.body;
    const regions = new Map();
    const leaves = new Map();
    const buckets = new Map();
    let total = 0;
    let narrow = 0;
    for (const el of shell.querySelectorAll("*")) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const px = pxOf(el);
      if (!(el.textContent || "").trim()) continue;
      total += 1;
      bump(buckets, px);
      const isNarrow = px >= 8 && px <= 11;
      if (isNarrow) narrow += 1;
      const region = regionOf(el);
      if (!regions.has(region)) regions.set(region, { total: 0, narrow: 0 });
      const r = regions.get(region);
      r.total += 1;
      if (isNarrow) r.narrow += 1;
      if (!leaves.has(region)) leaves.set(region, new Map());
      const cls = (el.getAttribute("class") || "").trim().split(/\s+/)[0] || el.tagName.toLowerCase();
      bump(leaves.get(region), `${el.tagName.toLowerCase()}.${cls}@${px}`);
    }
    const report = {
      totalTextNodes: total,
      narrowBandShare: total ? Math.round((narrow / total) * 1000) / 10 : 0,
      distribution: Object.fromEntries([...buckets.entries()].sort((a, b) => a[0] - b[0])),
      regions: Object.fromEntries(
        [...regions.entries()]
          .sort((a, b) => b[1].narrow - a[1].narrow)
          .map(([name, r]) => [
            name,
            { total: r.total, narrow: r.narrow, topLeaves: top(leaves.get(name), 6) },
          ]),
      ),
    };
    return { measured, ladderCheck, report };
  },
  { checks: CHECKS, ladder: PANEL_LADDER },
);

// ---- gate verdict -----------------------------------------------------------

console.log(
  `typography-audit: ${opened}/${want} dock panels open, ${result.measured.length} role checks + panel ladder\n`,
);
let failed = 0;
for (const m of [...result.measured, result.ladderCheck]) {
  const tag = m === result.ladderCheck ? "LADDER" : "ROLE";
  if (m.ok) {
    console.log(
      `  PASS  [${tag}] ${m.role.padEnd(38)} ${m.visible} visible: ${JSON.stringify(m.sizes)}` +
        (m.sample ? ` "${m.sample}"` : ""),
    );
  } else {
    failed += 1;
    console.log(`  FAIL  [${tag}] ${m.role.padEnd(38)} ${m.reason}`);
  }
}

console.log(`\ntype mass: ${result.report.totalTextNodes} text nodes, narrow band ${result.report.narrowBandShare}%`);
console.log(`distribution: ${JSON.stringify(result.report.distribution)}`);
for (const [name, r] of Object.entries(result.report.regions)) {
  console.log(`  ${name.padEnd(16)} total ${String(r.total).padStart(4)}  narrow ${String(r.narrow).padStart(4)}  ${JSON.stringify(r.topLeaves)}`);
}

await browser.close();

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(EXIT_GATE);
}
console.log("\nall typography roles applied");
process.exit(0);