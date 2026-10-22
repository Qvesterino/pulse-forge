// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveConfig } from "vite";

/**
 * The dev server must not DISCOVER a dependency while the app is booting.
 *
 * Vite's dep-optimizer scans the entry graph (index.html -> src/main.tsx) and
 * pre-bundles what it finds there. A dependency that is only reachable from
 * a WORKER module is outside that graph (Vite bundles workers separately), so
 * it is discovered at RUNTIME - when the studio creates the AI worker.
 *
 * A runtime discovery re-runs the optimizer, and a re-run changes the `?v=`
 * hash of EVERY optimized dep. The page then holds two copies of React
 * (measured 2026-10-22: `react.js?v=5e019cbd` AND `react.js?v=e2debdb6`),
 * which is the "Invalid hook call" / "Cannot read properties of null (reading
 * 'useState')" in the console - and Vite sends a FULL PAGE RELOAD, which
 * destroys the DOM the app-boot gate is waiting for and gets reported as
 * "UI did not mount".
 *
 * These specs pin the pre-declaration that prevents it.
 */

const repoRoot = path.resolve(__dirname, "..");

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Bare specifiers a module imports DYNAMICALLY - the ones a static scan of
 *  the entry graph cannot see. */
function dynamicBareImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out = new Set<string>();
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("http")) continue;
    out.add(spec);
  }
  return [...out];
}

async function viteConfig() {
  // Vite 6 requires the command as the second argument ("serve" = dev server).
  return resolveConfig(
    { root: repoRoot, configFile: path.join(repoRoot, "vite.config.ts") },
    "serve",
  );
}

describe("the dev server never discovers a dependency while the app boots", () => {
  it("every dependency an app WORKER imports dynamically is pre-declared for the optimizer", async () => {
    const config = await viteConfig();
    const declared = new Set(config.optimizeDeps.include ?? []);
    const workerFiles = walkFiles(path.join(repoRoot, "src")).filter((f) => /worker/i.test(path.basename(f)));
    expect(workerFiles.length).toBeGreaterThan(0);

    const late: string[] = [];
    for (const file of workerFiles) {
      for (const spec of dynamicBareImports(file)) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        // A declared package covers its subpaths ("onnxruntime-web" covers
        // "onnxruntime-web/wasm").
        const covered = [...declared].some((d) => d === spec || d === pkg);
        if (!covered) late.push(`${path.relative(repoRoot, file)} -> ${spec}`);
      }
    }
    expect(late, `late-discovered dependencies (they trigger a re-optimize + page reload): ${late.join(", ")}`).toEqual(
      [],
    );
  });

  it("the sibling's zod is EXCLUDED, never included", async () => {
    const config = await viteConfig();
    // zod resolves to the SIBLING's copy (3.25.76) for the sibling's source
    // and to the app root's copy (4.5.4) for the app - `include` resolves from
    // the root, so pre-bundling it would run a different zod in dev than in
    // the production build. Excluding keeps the resolution and skips the
    // optimizer.
    expect(config.optimizeDeps.exclude ?? []).toContain("zod");
    expect(config.optimizeDeps.include ?? []).not.toContain("zod");
  });

  it("the optimizer scan is pinned to the app entry", async () => {
    const config = await viteConfig();
    expect(config.optimizeDeps.entries).toEqual(["index.html"]);
  });

  it("both configs declare the react dedupe themselves", () => {
    // The RESOLVED config cannot be used here: @vitejs/plugin-react already
    // contributes `resolve.dedupe = ["react", "react-dom"]`, and mergeConfig
    // CONCATENATES arrays - so a resolved check stays green even when the
    // repo's own declaration is deleted. That is a false green; read the
    // files instead.
    for (const file of ["vite.config.ts", "vitest.config.ts"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      expect(
        /dedupe:\s*\[[^\]]*"react"[^\]]*"react-dom"[^\]]*\]/.test(text),
        `${file} must declare resolve.dedupe for react and react-dom`,
      ).toBe(true);
    }
  });

  it("the shared HUD source resolves a DIFFERENT react than the app (the hazard the dedupe exists for)", () => {
    const siblingRoot = process.env.QVESTER_SIBLING_ROOT ?? path.resolve(repoRoot, "..", "QVESTER_LANDING_PAGE");
    const chipImporter = path.join(siblingRoot, "packages", "qmr-hud", "src", "qmr-mini-chip-mount.tsx");
    const appImporter = path.join(repoRoot, "src", "main.tsx");
    const appReq = createRequire(appImporter);
    const appReact = appReq.resolve("react");
    const appVersion = JSON.parse(readFileSync(appReq.resolve("react/package.json"), "utf8")).version;
    let chipReact: string;
    try {
      chipReact = createRequire(chipImporter).resolve("react");
    } catch {
      // No sibling checkout here - the hazard cannot exist, and the dedupe is
      // harmless insurance.
      expect(appReact).toContain("pulse-forge");
      return;
    }
    expect(chipReact).not.toBe(appReact);
    expect(chipReact).toContain("QVESTER_LANDING_PAGE");
    // The HUD declares react ^19 as a peer dependency, but its SOURCE only
    // uses React-18 APIs. Pinning the app's own copy is therefore safe - and
    // only as long as the app stays on a version the HUD source compiles
    // against. This fails loudly if the app is ever moved to another major.
    expect(appVersion).toMatch(/^18\./);
  });
});
