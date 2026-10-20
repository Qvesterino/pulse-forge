/**
 * state-matrix.mts — PHASE A: record what each interaction state actually
 * looks like, and write it down.
 *
 *   npx vite-node scripts/state-matrix.mts [--url http://127.0.0.1:5173] [--shots] [--gate]
 *
 * WHAT IT DOES
 * ------------
 * Boots the studio ONCE, then drives it through each state and reads the same
 * role catalog the Diagnostics panel will read. Writes a JSON snapshot and a
 * screenshot per state.
 *
 * It declares nothing by itself: the output is DATA, not a verdict. Phase B
 * decides what each state SHOULD look like, from this data, with a human in
 * the loop. Deciding first is how wave 4 pinned a number to one sample.
 *
 * With --gate it additionally asserts the DECLARED expectations
 * (src/ui/stateMatrix.ts) against the recording it just took. The gate and
 * the panel read the same declaration, so they cannot drift apart.
 *
 * A STATE THAT WAS NOT ENTERED IS REPORTED AS NOT ENTERED. The recorder never
 * claims a state it could not actually reach — a gate that reports green over
 * an unmeasured surface is worse than no gate.
 *
 * Exit codes: 0 = recorded (and, with --gate, every expectation held),
 * 1 = a state could not be entered or an expectation failed, 2 = HARNESS_ERROR
 * (nothing was measured; NOT a result).
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootStudio } from "./lib/studio-boot.mjs";
import {
  STATE_EXPECTATIONS,
  STATE_ROLES,
  STATES,
  evaluateExpectation,
  readStateMatrix,
  type PixelContrast,
  type StateSnapshot,
} from "../src/ui/stateMatrix";

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf("--url");
const URL = urlIndex >= 0 ? argv[urlIndex + 1] : "http://127.0.0.1:5173";
const SHOTS = argv.includes("--shots");
/** Phase C: after recording, assert the DECLARED expectations against it. */
const GATE = argv.includes("--gate");
/**
 * Phase D: measure the contrast FROM THE PIXELS, for the roles whose
 * background the DOM cannot answer (a gradient ancestor).
 *
 * The gate always needs it: nine of the nineteen roles paint a gradient, and
 * a gate that cannot see those surfaces is a gate that checks a third of the
 * shell and calls it coverage.
 */
const PIXELS = argv.includes("--pixels") || GATE;

const EXIT_GATE = 1;
const EXIT_STATE_UNREACHED = 1;
const EXIT_HARNESS_ERROR = 2;
process.on("uncaughtException", (error) => {
  console.error(`HARNESS_ERROR (not a result - nothing was measured): ${error?.message ?? error}`);
  process.exit(EXIT_HARNESS_ERROR);
});

const outDir = resolve("output/state-matrix");
const shotDir = resolve("output/playwright");
mkdirSync(outDir, { recursive: true });
if (SHOTS) mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultNavigationTimeout(300_000);
page.setDefaultTimeout(300_000);

// ONE boot, shared with every other gate (scripts/lib/studio-boot.mjs).
// The first draft of this script carried its own copy and waited on
// `button.pb-template-start` — a class commit 8d11f16b removed from the
// markup. The template now lives in a CLOSED <details>, so the button is in
// the DOM but NOT visible, and waiting on visibility is what timed out.
await bootStudio(page, URL, { label: "state-matrix" });

/** Read the matrix out of the live DOM. */
const measure = async () => await page.evaluate(readStateMatrix, STATE_ROLES);

/**
 * MEASURE THE BACKGROUND FROM PIXELS — for the roles whose background the DOM
 * cannot answer.
 *
 * WHY
 * ---
 * Nine of the shell's roles paint a `background-image` (a gradient). For
 * those, the colour under the text depends on WHERE in the gradient the text
 * lands, and no amount of walking the DOM will say so. The static reader
 * reports them as unresolved, which is honest but useless as a gate.
 *
 * So the pixels are measured. Twice:
 *
 *   A  the element as rendered, text included
 *   B  the same pixels with the TEXT made transparent (background only)
 *
 * Where A differs from B, the text was painted. B's pixel there is the TRUE
 * background under that glyph — gradient, blur, backdrop-filter and all. The
 * contrast at that pixel is the real one. The WORST pixel is reported,
 * because WCAG asks for the worst case and a gradient's worst case is exactly
 * the thing a token-level calculation cannot see.
 *
 * The text colour comes from the computed style, not from A's pixels: A's
 * glyph pixels are antialiased blends, and a blend is not the text colour.
 */
/**
 * The text colours of an element: the colours of the elements that actually
 * OWN TEXT.
 *
 * Not the element's own `color`. A `.row-pad` owns no text itself — its
 * `.row-pad-name` child does, and that child may wear a DIFFERENT colour (a
 * selected row's name goes amber). Reading the parent's inherited colour
 * would measure a colour that is not on the screen, and the pixel test would
 * then reject every glyph as "not text".
 */
/**
 * The regions every role occupies, with the colours of its text.
 *
 * ONE evaluate for all roles, and it uses the SAME "first VISIBLE match" rule
 * as the static reader. The first version took the first match in DOM order —
 * which for `h3.panel-title` is a heading inside a panel that is not open, so
 * the pixel measurement looked at a hidden heading while the static reader
 * measured the visible one. Two methods, two elements, two different numbers.
 *
 * The text colours are those of the elements that OWN TEXT, not the element's
 * own `color`: a `.row-pad` owns no text itself — its `.row-pad-name` child
 * does, and that child may wear a DIFFERENT colour (a selected row's name
 * goes amber). Reading the parent's inherited colour would measure a colour
 * that is not on the screen, and the pixel test would then reject every glyph
 * as "not text".
 *
 * And the region is the TEXT OWNER'S BOX, not the role's box. The role's box
 * includes its BORDER — and `.track-header-name` carries a 3px amber left
 * border, so scanning the role's box invented a "green text on pure amber,
 * 1.23:1" reading that was really the text's antialiased edge next to a
 * border. A border is not the surface a text is read against.
 */
const collectRoleRegions = async (): Promise<RoleRegion[]> =>
  await page.evaluate((roles) => {
    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return el.getBoundingClientRect().height > 0;
    };
    const out: {
      id: string;
      parts: { color: string; x: number; y: number; w: number; h: number }[];
    }[] = [];
    for (const role of roles) {
      const el = [...document.querySelectorAll(role.selector)].filter(visible)[0];
      if (!el) continue;
      const parts: { color: string; x: number; y: number; w: number; h: number }[] = [];
      const seen = new Set<string>();
      for (const node of [el, ...el.querySelectorAll("*")]) {
        const ownsText = [...node.childNodes].some(
          (child) => child.nodeType === 3 && (child.textContent ?? "").trim().length > 0,
        );
        if (!ownsText) continue;
        const r = node.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const color = getComputedStyle(node).color;
        const key = `${color}|${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push({ color, x: r.x, y: r.y, w: r.width, h: r.height });
      }
      out.push({ id: role.id, parts });
    }
    return out;
  }, STATE_ROLES);

/** One role's text: where it is, and in which colour. */
interface RoleRegion {
  id: string;
  parts: { color: string; x: number; y: number; w: number; h: number }[];
}

/**
 * Hide the TEXT of every role at once, keeping every background.
 *
 * `color: transparent` on the element and every descendant. `visibility:
 * hidden` would take the background with it. The previous inline value is
 * restored EXACTLY afterwards — `removeProperty` on every node would have
 * destroyed the inline colours some of these elements legitimately carry.
 *
 * ONE pass for all roles, not one per role. The first version took two
 * screenshots per role, and on the software-rendered canvas that cost 200
 * seconds PER STATE. Two screenshots per state is the same measurement.
 */
const hideRoleText = async (): Promise<boolean> =>
  await page.evaluate((roles) => {
    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return el.getBoundingClientRect().height > 0;
    };
    const targets: HTMLElement[] = [];
    for (const role of roles) {
      const el = [...document.querySelectorAll(role.selector)].filter(visible)[0];
      if (el) targets.push(el as HTMLElement);
    }
    if (!targets.length) return false;
    const seen = new Set<HTMLElement>();
    const touched: { el: HTMLElement; value: string; priority: string }[] = [];
    for (const el of targets) {
      for (const node of [el, ...el.querySelectorAll("*")]) {
        const h = node as HTMLElement;
        // A nested role would otherwise record the ALREADY modified value
        // and never restore it.
        if (seen.has(h)) continue;
        seen.add(h);
        const style = h.style;
        touched.push({
          el: h,
          value: style.getPropertyValue("color"),
          priority: style.getPropertyPriority("color"),
        });
        style.setProperty("color", "transparent", "important");
      }
    }
    (window as unknown as { __contrastRestore?: () => void }).__contrastRestore = () => {
      for (const t of touched) {
        if (t.value) t.el.style.setProperty("color", t.value, t.priority);
        else t.el.style.removeProperty("color");
      }
    };
    return true;
  }, STATE_ROLES);

async function measureContrastByPixels(): Promise<Map<string, PixelContrast>> {
  const result = new Map<string, PixelContrast>();
  const viewport = page.viewportSize();
  if (!viewport) return result;

  // 1. Where each role's text is, and in which colours.
  const regions = await collectRoleRegions();
  const clipped = regions
    .map((r) => ({
      id: r.id,
      parts: r.parts
        .map((p) => {
          const x = Math.max(0, p.x);
          const y = Math.max(0, p.y);
          return { ...p, x, y, w: Math.min(p.w, viewport.width - x), h: Math.min(p.h, viewport.height - y) };
        })
        .filter((p) => p.w >= 2 && p.h >= 2),
    }))
    .filter((r) => r.parts.length > 0);
  if (!clipped.length) return result;

  // 2. The whole viewport, twice: with the text, and without it.
  const withText = (await page.screenshot({ scale: "css" })).toString("base64");
  const hidden = await hideRoleText();
  if (!hidden) return result;
  await page.waitForTimeout(80);
  const withoutText = (await page.screenshot({ scale: "css" })).toString("base64");
  await page.evaluate(() => {
    const restore = (window as unknown as { __contrastRestore?: () => void }).__contrastRestore;
    if (restore) restore();
  });
  await page.waitForTimeout(80);

  // 3. Analyse every role out of the two images.
  const analysed = await page.evaluate(
    async ({ a, b, regions }) => {
      const load = async (dataUrl: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${dataUrl}`;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0);
        return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
      };
      const A = await load(a);
      const B = await load(b);
      if (!A || !B) return [];

      // Rasterise the text colours through the BROWSER's own colour
      // pipeline. `fillStyle` understands every syntax the engine
      // understands — `color(srgb ...)`, `oklab(...)`, a `color-mix()`
      // result — and `getImageData` returns the bytes the engine would
      // actually paint. A regex over the serialised string would have to
      // re-implement that, and would get it wrong for the two formats this
      // shell uses 1160 and 192 times respectively.
      const probe = new OffscreenCanvas(1, 1);
      const pctx = probe.getContext("2d");
      if (!pctx) return [];
      const SENTINEL = "rgb(1, 2, 3)";
      const parsed = new Map<string, { r: number; g: number; b: number; a: number }>();
      for (const color of new Set(regions.flatMap((rg) => rg.parts.map((pt) => pt.color)))) {
        pctx.fillStyle = SENTINEL;
        pctx.fillStyle = color;
        pctx.fillRect(0, 0, 1, 1);
        const d = pctx.getImageData(0, 0, 1, 1).data;
        // The sentinel survived -> the colour did not parse.
        if (d[0] === 1 && d[1] === 2 && d[2] === 3) continue;
        parsed.set(color, { r: d[0], g: d[1], b: d[2], a: d[3] / 255 });
      }

      const ch = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const lum = (r: number, g: number, bl: number) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(bl);

      const out: unknown[] = [];
      for (const region of regions) {
        /**
         * The pixels are GROUPED by the (background, text colour) pair they
         * show, not averaged and not reduced to a single worst pixel.
         *
         * A single stray pixel — the top of a glyph grazing a 1px top-light —
         * is a rendering detail, not a surface the text is read against. But a
         * gradient the text genuinely spans IS. Grouping tells the two apart:
         * the group's pixel count says how much text actually sits on that
         * surface, and the DECLARATION can then require a real area.
         */
        const groups = new Map<
          string,
          { count: number; ratio: number; bg: number[]; text: string; x: number; y: number }
        >();
        let sum = 0;
        let count = 0;

        for (const part of region.parts) {
          const x0 = Math.max(0, Math.round(part.x));
          const y0 = Math.max(0, Math.round(part.y));
          const x1 = Math.min(A.width, x0 + Math.round(part.w));
          const y1 = Math.min(A.height, y0 + Math.round(part.h));
          const color = part.color;

          for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
              const i = (y * A.width + x) * 4;
              const ar = A.data[i];
              const ag = A.data[i + 1];
              const ab = A.data[i + 2];
              const br = B.data[i];
              const bg = B.data[i + 1];
              const bb = B.data[i + 2];
              if (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb) < 6) continue; // unchanged

              const t = parsed.get(color);
              if (!t) continue;
              // The text colour as it lands on THIS background.
              const tr = t.a * t.r + (1 - t.a) * br;
              const tg = t.a * t.g + (1 - t.a) * bg;
              const tb = t.a * t.b + (1 - t.a) * bb;
              const dx = tr - br;
              const dy = tg - bg;
              const dz = tb - bb;
              const len2 = dx * dx + dy * dy + dz * dz;
              if (len2 < 1) continue;
              let cover = ((ar - br) * dx + (ag - bg) * dy + (ab - bb) * dz) / len2;
              if (cover < 0) cover = 0;
              if (cover > 1) cover = 1;
              const pr = br + cover * dx;
              const pg = bg + cover * dy;
              const pbb = bb + cover * dz;
              const residual = Math.abs(ar - pr) + Math.abs(ag - pg) + Math.abs(ab - pbb);
              // A pixel that is NOT on the line between the background and
              // the text colour is not text: it is a ring, a border, a
              // playhead animation, or a glyph painted in another colour.
              if (residual > 48) continue;
              if (cover < 0.05) continue; // essentially nothing painted here
              const lText = lum(tr, tg, tb);
              const lBg = lum(br, bg, bb);
              const ratio = (Math.max(lText, lBg) + 0.05) / (Math.min(lText, lBg) + 0.05);
              const key = `${br},${bg},${bb}|${color}`;
              const group = groups.get(key);
              if (group) group.count += 1;
              else groups.set(key, { count: 1, ratio, bg: [br, bg, bb], text: color, x: x - x0, y: y - y0 });
              sum += ratio;
              count += 1;
            }
          }
        }
      }

        let worst: { count: number; ratio: number; bg: number[]; text: string; x: number; y: number } | null = null;
        let sliver: { count: number; ratio: number; bg: number[]; text: string; x: number; y: number } | null = null;
        const total = [...groups.values()].reduce((n, g) => n + g.count, 0);
        /**
         * A surface only counts as "the surface the text is read against" if
         * it carries a REAL SHARE of the text: at least 10% of the role's
         * text pixels, and never fewer than two.
         *
         * The 10% is not a fudge factor — it sits in the gap the measurement
         * actually shows. A real surface carries 45–100% of the text (the
         * index on the selected row: 10 of 22 pixels on one tint). A stray
         * pixel carries 0.6–2.6% (the top of a glyph grazing a 1px top-light,
         * a moving meter edge). Nothing lands between 3% and 45%.
         */
        const minShare = Math.max(2, total * 0.1);
        let overall: { count: number; ratio: number; bg: number[]; text: string; x: number; y: number } | null = null;
        for (const group of groups.values()) {
          if (!overall || group.ratio < overall.ratio) overall = group;
          if (group.count >= minShare) {
            if (!worst || group.ratio < worst.ratio) worst = group;
          } else if (!sliver || group.ratio < sliver.ratio) sliver = group;
        }
        /**
         * When NO surface carries a tenth of the text, the text is spread thin
         * over a gradient — there is no dominant surface, so the concept of an
         * outlier does not apply and the WORST surface is the honest reading.
         *
         * The alternative was to report "no measurement", which is what the
         * first version did by accident: it returned 0:1, a number that reads
         * as "the worst contrast possible" and is really "I did not look".
         */
        if (!worst) worst = overall;

        const shape = {
          id: region.id,
          textPixels: count,
          surfaces: groups.size,
          minSurfacePixels: minShare,
          worstBackground: worst ? `rgb(${worst.bg[0]}, ${worst.bg[1]}, ${worst.bg[2]})` : null,
          worstTextColor: worst ? worst.text : null,
          worstSurfacePixels: worst ? worst.count : 0,
          worstPixel: worst ? { x: worst.x, y: worst.y } : null,
          sliverContrast: sliver ? Math.round(sliver.ratio * 100) / 100 : null,
          sliverPixels: sliver ? sliver.count : 0,
          textColors: region.colors,
        };
        if (count === 0) out.push({ ...shape, minContrast: null, meanContrast: null });
        else
          out.push({
            ...shape,
            minContrast: Math.round((worst?.ratio ?? 0) * 100) / 100,
            meanContrast: Math.round((sum / count) * 100) / 100,
          });
      }
      return out;
    },
    { a: withText, b: withoutText, regions },
  );

  for (const entry of analysed as PixelContrast[]) {
    result.set(entry.id, entry);
  }
  return result;
}

const snapshots: StateSnapshot[] = [];

async function record(stateId: string, entered: boolean, note?: string) {
  const def = STATES.find((s) => s.id === stateId);
  const readings = await measure();
  const snapshot: StateSnapshot = {
    state: stateId,
    label: def?.label ?? stateId,
    entered,
    ...(note ? { note } : {}),
    readings,
  };
  snapshots.push(snapshot);
  if (SHOTS) {
    await page.screenshot({ path: resolve(shotDir, `state-${stateId}.png`) });
  }

  // ---- phase D: the pixel measurement, taken while THIS state is live ------
  // It has to run here, not at the end: the background under the text is a
  // property of the state (a selected row repaints its own background), so a
  // measurement taken after the transport moved would be measuring another
  // state than the one the snapshot describes.
  if (PIXELS) {
    const started = Date.now();
    const pixels = await measureContrastByPixels();
    for (const r of readings) {
      const p = pixels.get(r.roleId);
      if (p) r.pixelContrast = p;
    }
    console.log(`      (pixel measurement: ${Date.now() - started} ms)`);
  }
  const accents = readings.filter((r) => r.hasAccent).map((r) => r.roleId);
  const marked = readings.filter((r) => r.accentCount > 0).map((r) => `${r.roleId}(${r.accentCount})`);
  const rings = readings.filter((r) => r.ringCount > 0).map((r) => `${r.roleId}(${r.ringCount})`);
  const borders = readings.filter((r) => r.borderAccentCount > 0).map((r) => `${r.roleId}(${r.borderAccentCount})`);
  const outlines = readings.filter((r) => r.outlineCount > 0).map((r) => `${r.roleId}(${r.outlineCount})`);
  console.log(
    `  ${entered ? "entered" : "NOT ENTERED"}  ${stateId.padEnd(10)} ` +
      `roles=${readings.filter((r) => r.visible > 0).length}/${readings.length}` +
      (marked.length ? `  inset: ${marked.join(", ")}` : "") +
      (borders.length ? `  border: ${borders.join(", ")}` : "") +
      (rings.length ? `  rings: ${rings.join(", ")}` : "") +
      (outlines.length ? `  outline: ${outlines.join(", ")}` : ""),
  );
  // Phase D: the contrast of every role that has text.
  //
  // TWO numbers, because they answer different questions:
  //
  //   static  the composited background from the DOM — exact where the
  //           background is a solid colour, and REPORTED AS UNRESOLVED where
  //           an ancestor paints a gradient.
  //   pixel   the background taken from the rendered pixels under the glyphs
  //           — the real one, gradient included, and the WORST of it.
  //
  // Where the static background WAS resolved, the two must agree. That
  // agreement is the check on the compositing maths, not a coincidence.
  const contrast = readings.filter((r) => r.contrast !== null || r.pixelContrast?.minContrast != null);
  if (contrast.length) {
    for (const r of contrast) {
      const px = r.pixelContrast?.minContrast ?? null;
      const effective = px ?? r.contrast;
      const flag = effective !== null && effective < r.contrastFloor ? "  BELOW AA" : "";
      const staticText = r.contrast === null ? "unresolved" : `${r.contrast}:1`;
      const pixelText = px === null ? "—" : `${px}:1`;
      const bg = r.pixelContrast?.worstBackground ?? r.compositedBackground ?? "?";
      const who = r.pixelContrast?.worstTextColor ?? r.color ?? "?";
      const pxCount = r.pixelContrast ? ` ${r.pixelContrast.textPixels}px` : "";
      const surf = r.pixelContrast ? ` s${r.pixelContrast.surfaces}` : "";
      const surfPx = r.pixelContrast ? ` worst${r.pixelContrast.worstSurfacePixels}px` : "";
      const sliver =
        r.pixelContrast?.sliverContrast != null
          ? `  (stray ${r.pixelContrast.sliverContrast}:1 on ${r.pixelContrast.sliverPixels}px)`
          : "";
      console.log(
        `      ${r.roleId.padEnd(20)} static ${staticText.padStart(9)}   pixel ${pixelText.padStart(6)}${pxCount.padStart(8)}${surf.padStart(4)}${surfPx.padStart(12)}   ` +
          `floor ${r.contrastFloor}   ${who} on ${bg}${flag}${sliver}`,
      );
    }
  }
  const unresolved = readings.filter((r) => r.visible > 0 && !r.backgroundResolved);
  if (unresolved.length) {
    console.log(
      `      unresolved backgrounds: ${unresolved.map((r) => `${r.roleId} (${r.backgroundNote})`).join(", ")}`,
    );
  }
  if (note) console.log(`      ${note}`);
  return snapshot;
}

// ---- idle ------------------------------------------------------------------
// "Idle" is a CLAIM: nothing is playing and nothing is marked as the
// playhead. Asserting it costs two queries and stops a green run from
// meaning "the transport was already running when we called it idle".
const idlePlay = (await page.locator(".btn-play.active").count()) > 0;
const idleHead = (await page.locator(".step.playhead").count()) > 0;
await page.waitForTimeout(400);
await record("idle", !idlePlay && !idleHead, idlePlay || idleHead ? "the transport was already running" : undefined);

// ---- selected --------------------------------------------------------------
// The selection has to MOVE for this state to mean anything.
//
// The first version clicked `.row-pad` — the FIRST row — which is ALREADY
// selected, so the reading came back byte-identical to idle and "selected"
// was indistinguishable from "idle" in the data while the screenshot looked
// the same too. Now it clicks a row that is not selected and proves the mark
// moved to it.
const beforeSelection = (await measure()).find((r) => r.roleId === "rowPad")?.accentSample ?? null;
const otherRow = page.locator(".row-pad:not(.selected)").first();
if ((await otherRow.count()) > 0) {
  await otherRow.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(600);
  const after = (await measure()).find((r) => r.roleId === "rowPad");
  const moved = !!after?.accentSample && after.accentSample !== beforeSelection;
  await record("selected", moved, moved ? undefined : `the selection did not move (still "${after?.accentSample}")`);
} else {
  await record("selected", false, "no unselected .row-pad to click");
}

// ---- playing ---------------------------------------------------------------
// Two independent signals, not one: the transport says it is running AND the
// grid is actually marking a playhead column. A run that only checks the
// button class would happily record "playing" over a frozen grid.
const play = page.locator(".btn-play").first();
if ((await play.count()) > 0) {
  await play.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const transportRunning = (await page.locator(".btn-play.active").count()) > 0;
  const playheadCells = (await page.locator(".step.playhead").count()) > 0;
  await record(
    "playing",
    transportRunning && playheadCells,
    !transportRunning
      ? "the transport did not report a playing state"
      : !playheadCells
        ? "the transport is running but no step carries the playhead mark"
        : undefined,
  );
} else {
  await record("playing", false, "no .btn-play in the shell");
}

// ---- hover -----------------------------------------------------------------
// Stop first: a moving playhead would confound a reading about hover.
const stop = page.locator(".btn-stop").first();
if ((await stop.count()) > 0) await stop.click({ timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(500);
const hoverTarget = page.locator(".transport-cluster .btn").first();
if ((await hoverTarget.count()) > 0) {
  await hoverTarget.hover({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(300);
  // `:hover` is the pointer's real answer, not an assumption that the hover
  // call worked. The first version recorded "hover" unconditionally.
  const hovering = await hoverTarget.evaluate((el) => el.matches(":hover")).catch(() => false);
  await record("hover", hovering, hovering ? undefined : "the pointer is not actually over the control");
  await page.mouse.move(5, 5).catch(() => {});
  await page.waitForTimeout(200);
} else {
  await record("hover", false, "no .transport-cluster .btn to hover");
}

// ---- focus -----------------------------------------------------------------
// Keyboard focus needs THREE things, and getting only some of them yields a
// state that looks right and measures nothing:
//
//   1. KEYBOARD MODALITY. Chromium arms `:focus-visible` only when the last
//      interaction was the keyboard. The hover state before this one left the
//      pointer on a button, so `:focus-visible` did not match and the "focus"
//      recording was pixel-identical to "idle".
//   2. THE FOCUS ITSELF. `element.focus()` moves DOM focus; measured here,
//      it does arm `:focus-visible` once the modality is right.
//   3. A VISIBLE RING. This shell's focus ring is an OUTLINE, not a shadow,
//      so the reader counts outlines over the whole set — the focused element
//      is one of many, and the first element of the set is not it.
//
// Tab is NOT the way in: measured, Tab never moved `activeElement` off BODY
// in this app, so the recorder drives focus directly and ASSERTS the ring.
await page.keyboard.press("Shift");
await page.waitForTimeout(120);

const focusTarget =
  (await page.locator(".transport-cluster .btn-play").count()) > 0
    ? page.locator(".transport-cluster .btn-play").first()
    : page.locator(".transport-cluster .btn").first();
if ((await focusTarget.count()) > 0) {
  await focusTarget.focus({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(400);
  const focusInfo = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { inTransport: false, focusVisible: false, outline: "" };
    const cs = getComputedStyle(el);
    return {
      inTransport: !!el.closest(".transport-cluster"),
      focusVisible: el.matches(":focus-visible"),
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
    };
  });
  const readings = await measure();
  const transport = readings.find((r) => r.roleId === "transportBtn");
  const ringed = (transport?.outlineCount ?? 0) > 0;
  const entered = focusInfo.inTransport && focusInfo.focusVisible && ringed;
  await record(
    "focus",
    entered,
    entered
      ? undefined
      : !focusInfo.inTransport
        ? "focus did not land on a transport control"
        : !focusInfo.focusVisible
          ? "the control has DOM focus but not :focus-visible"
          : "no focus ring was painted (outline count 0)",
  );
  // Drop the focus ring before the next state. It is an OUTLINE on a focused
  // control, and the recording state clicks a control — so without this the
  // focus ring leaks into the recording snapshot and the two states stop
  // being distinguishable.
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && typeof (el as HTMLElement).blur === "function") (el as HTMLElement).blur();
  });
  await page.waitForTimeout(300);
} else {
  await record("focus", false, "no transport control to focus");
}

// ---- recording -------------------------------------------------------------
// The transport's RECORD is MIDI overdub into the pattern (patternRecorder),
// not microphone capture - so it needs no permission dialog and IS reachable.
// Two signals: the button is lit, and the OVERDUB/REPLACE mode selector that
// only exists while armed is present.
const rec = page.locator(".btn-record").first();
if ((await rec.count()) > 0) {
  await rec.click({ timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  const armed = (await page.locator(".btn-record.armed").count()) > 0;
  const modeSelector = (await page.locator("select.rec-option").count()) > 0;
  await record(
    "recording",
    armed && modeSelector,
    !armed
      ? "the record button did not report an armed state"
      : !modeSelector
        ? "the record button is armed but the record-mode selector is absent"
        : undefined,
  );
} else {
  await record("recording", false, "no .btn-record in the shell");
}

await context.close();
await browser.close();

writeFileSync(resolve(outDir, "snapshot.json"), JSON.stringify({ states: snapshots }, null, 2));
for (const s of snapshots) {
  writeFileSync(resolve(outDir, `${s.state}.json`), JSON.stringify(s, null, 2));
}

// A state that could not be entered is a RESULT, not a harness error: the
// recorder did its job and the answer is "this surface was not reachable".
const unreached = snapshots.filter((s) => !s.entered);
console.log(`\nrecorded ${snapshots.length - unreached.length}/${snapshots.length} states -> ${outDir}`);

// ---- phase C: the gate ------------------------------------------------------
// The declaration lives in src/ui/stateMatrix.ts and is read HERE, so the gate
// and the Diagnostics panel cannot drift apart.
//
// A RULE WHOSE STATE WAS NOT ENTERED IS A FAILURE, not a skipped check. A
// gate that quietly skips the rules it could not reach is exactly the failure
// this project keeps paying for: green over an unmeasured surface. That is why
// the gate runs BEFORE the unreached-state exit — so one run reports both the
// unreachable surface and the rules it could not check.
if (GATE) {
  const idleSnapshot = snapshots.find((s) => s.state === "idle");
  const idleByRole = new Map((idleSnapshot?.readings ?? []).map((r) => [r.roleId, r]));
  let failed = 0;

  console.log("\n=== declared expectations ===");
  for (const expectation of STATE_EXPECTATIONS) {
    const snapshot = snapshots.find((s) => s.state === expectation.state);
    if (!snapshot || !snapshot.entered) {
      failed += 1;
      console.log(
        `  FAIL  [${expectation.state}] ${expectation.role} — the state was not entered, so the rule was never checked`,
      );
      continue;
    }
    const reading = snapshot.readings.find((r) => r.roleId === expectation.role);
    const result = evaluateExpectation(expectation, reading, idleByRole.get(expectation.role));
    if (result.ok) {
      console.log(`  PASS  [${expectation.state}] ${expectation.role}`);
    } else {
      failed += 1;
      console.log(`  FAIL  [${expectation.state}] ${expectation.role}: ${result.failures.join("; ")}`);
      console.log(`        because: ${result.because}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} declared expectation(s) FAILED`);
    process.exit(EXIT_GATE);
  }
  console.log(`\nall ${STATE_EXPECTATIONS.length} declared expectations hold`);
}

if (unreached.length) {
  console.error(`\n${unreached.length} state(s) could not be entered: ${unreached.map((s) => s.state).join(", ")}`);
  process.exit(EXIT_STATE_UNREACHED);
}

process.exit(0);
