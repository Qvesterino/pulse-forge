// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveConfig } from "vite";

/**
 * THE QMR HUD IS AN OPTIONAL BUILD DEPENDENCY.
 *
 * The chip trigger ships as TS source from the sibling monorepo
 * (D:\QVESTER_LANDING_PAGE), and a clean checkout has no sibling. When the
 * app imported it statically, `vite build` died on ENOENT and the studio
 * crashed on boot — five red CI jobs on GitHub Actions on 2026-10-28, all
 * from ONE cross-repo import.
 *
 * These specs are the tripwire: the app must never statically import
 * @qvester/*, the alias must always resolve to a file that EXISTS, and the
 * in-repo stub must be a real module. A future wave that reintroduces the
 * static import turns this red on the dev machine — before CI, not after.
 */

const repoRoot = path.resolve(__dirname, "..");

function filesIn(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) filesIn(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Vite hands back the alias list either as an array or as a record. */
function aliasEntries(alias: unknown): Array<{ find: unknown; replacement: string }> {
  if (Array.isArray(alias)) return alias as Array<{ find: unknown; replacement: string }>;
  if (alias && typeof alias === "object") {
    return Object.entries(alias as Record<string, string>).map(([find, replacement]) => ({
      find,
      replacement: String(replacement),
    }));
  }
  return [];
}

describe("the QMR HUD is an optional build dependency", () => {
  it("no app source STATICALLY imports @qvester/* (a clean checkout must build)", () => {
    const offenders: string[] = [];
    for (const file of filesIn(path.join(repoRoot, "src"))) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(repoRoot, file);
      if (/^\s*import\s+(?!type\b)[^;]*?from\s+["']@qvester\//m.test(text)) {
        offenders.push(`${rel} — static import`);
      }
      if (/^\s*import\s+["']@qvester\//m.test(text)) {
        offenders.push(`${rel} — side-effect import`);
      }
    }
    expect(
      offenders,
      "a static @qvester import makes the build depend on the sibling checkout — use a dynamic import() or a local module",
    ).toEqual([]);
  });

  it("the chip is loaded DYNAMICALLY (it must never enter the boot path)", () => {
    const text = readFileSync(path.join(repoRoot, "src/ui/QmrChipMount.tsx"), "utf8");
    expect(text).toMatch(/import\(\s*["']@qvester\/qmr-hud\//);
  });

  it("the command bus the app answers on is KYX's own module", () => {
    const text = readFileSync(path.join(repoRoot, "src/ui/QmrChipMount.tsx"), "utf8");
    expect(text).toMatch(/from\s+["']\.\.\/interop\/qmrCommandBus["']/);
  });

  it("the @qvester alias resolves to a file that EXISTS (sibling checkout or in-repo stub)", async () => {
    const config = await resolveConfig({ root: repoRoot, configFile: path.join(repoRoot, "vite.config.ts") }, "serve");
    const entries = aliasEntries(config.resolve.alias);
    const hud = entries.find((entry) => entry.find instanceof RegExp && entry.find.test("@qvester/qmr-hud"));
    expect(hud, "the @qvester/qmr-hud alias must exist").toBeDefined();
    expect(
      existsSync(hud!.replacement),
      `the alias points at ${hud!.replacement}, which does not exist — the build would die on ENOENT`,
    ).toBe(true);
  });

  it("the vitest config mirrors the vite config (same sibling root, same stub fallback)", () => {
    const text = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
    expect(text).toContain("QVESTER_SIBLING_ROOT");
    expect(text).toContain("src/integrations/qmr-hud-stub");
  });

  it("the in-repo stub is a real module that renders nothing", async () => {
    const stub = path.join(repoRoot, "src/integrations/qmr-hud-stub/qmr-mini-chip-mount.tsx");
    expect(existsSync(stub)).toBe(true);
    const mod = await import("../src/integrations/qmr-hud-stub/qmr-mini-chip-mount");
    expect(mod.QmrMiniChipMount({})).toBe(null);
    expect(mod.QMR_HUD_STUB_MARKER).toBe("kyx-qmr-hud-stub");
  });
});
