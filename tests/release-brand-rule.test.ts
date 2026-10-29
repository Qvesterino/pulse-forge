import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLegacyPublicBrandLabel, hasLegacyPublicBrandLabel } from "../scripts/release-brand-rule.mjs";

/**
 * The release brand rule is an INVARIANT, not a preference.
 *
 * The preflight refuses a shipped artifact that carries a legacy public
 * brand label. That rule has to draw exactly one line:
 *
 *   - user-facing copy (display names, keywords) — FORBIDDEN, because a
 *     person reads it and would see the product under its old name;
 *   - identifiers (appIds, route slugs, repository slugs) — ALLOWED,
 *     because the ecosystem interop edges depend on them and renaming one
 *     breaks a live link between apps.
 *
 * Getting the line wrong in either direction is a bug: too wide and the
 * release cannot ship at all (measured 2026-10-29: the gate failed on
 * `repo://vocalforge-daw`, a repository slug), too narrow and the old
 * brand reaches the public artifact.
 */
describe("release brand rule", () => {
  it("catches the legacy name in user-facing copy", () => {
    const userFacing = [
      'appName: "KYX (Pulse Forge)"',
      'appName: "ZYVO (VocalForge DAW)"',
      '"displayName": "Pulse Forge"',
      '"displayName": "VocalForge DAW"',
      '"keywords": ["pulse forge", "kyx", "beat"]',
      '"keywords": ["vocalforge", "zyvo", "daw"]',
      "PulseForge",
      "the Pulse Forge workstation",
    ];
    for (const text of userFacing) {
      expect(hasLegacyPublicBrandLabel(text), text).toBe(true);
    }
  });

  it("allows the legacy name inside an identifier", () => {
    const identifiers = [
      'appId: "pulse_forge"',
      'appId: "vocalforge_daw"',
      'route: "/pulse-forge"',
      'target: "repo://vocalforge-daw"',
      "const VOCALFORGE_DAW_MANIFEST = buildManifest({",
      "sourceApp: 'pulse_forge'",
      'returnTarget: { appId: "pulse_forge", route: "/pulse-forge" }',
    ];
    for (const text of identifiers) {
      expect(hasLegacyPublicBrandLabel(text), text).toBe(false);
    }
  });

  it("reports the label it found, so the failure names the offender", () => {
    expect(findLegacyPublicBrandLabel('appName: "KYX (Pulse Forge)"')).toBe("Pulse Forge");
    expect(findLegacyPublicBrandLabel('appId: "pulse_forge"')).toBeNull();
  });

  it("has ONE rule: the preflight runner imports it instead of repeating it", () => {
    const runner = readFileSync(path.resolve(__dirname, "../scripts/release-preflight.mjs"), "utf8");
    expect(runner).toContain('from "./release-brand-rule.mjs"');
    expect(runner).toContain("findLegacyPublicBrandLabel");
    // No second, inline copy of the pattern may creep back in.
    expect(runner).not.toMatch(/pulse\\s\+forge/i);
    expect(runner).not.toMatch(/vocalforge\\b/i);
  });

  it("reads the CURRENT public names as clean", () => {
    const clean = [
      'appName: "KYX"',
      'appName: "ZYVO"',
      '"displayName": "KYX"',
      '"displayName": "ZYVO"',
      '"icon": "KX"',
      '"icon": "ZV"',
    ];
    for (const text of clean) {
      expect(hasLegacyPublicBrandLabel(text), text).toBe(false);
    }
  });
});
