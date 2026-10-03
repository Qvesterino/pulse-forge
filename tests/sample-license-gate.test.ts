import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";
import { LICENSES, PACK_CREDITS, renderCredits } from "../src/sample-library/licenses";

/**
 * SAMPLE LICENSE GATE (real-samples campaign, 2026-10-02) — the app
 * REDISTRIBUTES raw sample WAVs inside its own binary, which is stricter
 * than "free for your music" site licenses. This gate locks:
 *   1. every imported asset (source declared) carries a registry license
 *      that is redistributable (CC0 / CC-BY-3.0 / CC-BY-4.0 / kyx-original),
 *   2. NC / ND / SA variants are structurally impossible (not in LICENSES),
 *   3. credits.md matches a fresh render of PACK_CREDITS (CC-BY obligation),
 *   4. the credits file ships in public/ so it deploys with the app.
 */

const creditsPath = path.resolve(__dirname, "..", "public", "licenses", "credits.md");

describe("sample license gate", () => {
  it("every imported factory asset carries a redistributable license + source", () => {
    for (const asset of FACTORY_ASSETS) {
      if (!asset.source) continue; // first-party synthesized — no license needed
      expect(LICENSES[asset.license ?? ""]?.redistributable, `${asset.id}: license must be registry-listed`).toBe(true);
      expect(asset.source.length, `${asset.id}: source must name the pack`).toBeGreaterThan(0);
    }
  });

  it("NC / ND / SA licenses are structurally rejected", () => {
    // The registry simply has no entries for them — a pack cannot be added
    // with a non-redistributable license without widening the type.
    const ids = Object.keys(LICENSES);
    expect(ids).not.toContain("cc-by-nc");
    expect(ids).not.toContain("cc-by-nd");
    expect(ids).not.toContain("cc-by-sa");
    for (const info of Object.values(LICENSES)) {
      expect(info.redistributable, info.id).toBe(true);
    }
  });

  it("credits.md matches a fresh render of PACK_CREDITS (CC-BY obligation)", () => {
    const shipped = readFileSync(creditsPath, "utf8");
    expect(shipped).toBe(renderCredits());
    // Every CC-BY pack must appear in the rendered credits.
    for (const pack of PACK_CREDITS) {
      expect(shipped).toContain(pack.pack);
      if (pack.license === "cc-by-3.0" || pack.license === "cc-by-4.0") {
        expect(shipped).toContain(pack.sourceUrl);
      }
    }
  });

  it("every pack credits line names the license registry entry", () => {
    for (const pack of PACK_CREDITS) {
      expect(LICENSES[pack.license], pack.pack).toBeDefined();
      expect(pack.sourceUrl, pack.pack).toMatch(/^https?:\/\//);
    }
  });
});
