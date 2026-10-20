import { describe, expect, it } from "vitest";
import { createHeadlessMcpHost } from "../src/mcp/headless-host";
import { createDefaultProject } from "../src/project-model/schema";
import { bassHarmonicParams, KOREN_CHARACTER_LABELS, KOREN_KEY_MODE_LABELS } from "../src/effects/definitions";

/**
 * KOREŇ must be LEGIBLE to an agent (and to a new user).
 *
 * `kyx_catalog subject:effect effect:bassHarmonic` is the only surface an MCP
 * client has for learning what a knob does. A range alone — `presence: 0..1,
 * default 0` — cannot tell a model that PRESENCE is the phone band while TILT
 * is a spectral slope, so every KOREŇ parameter carries a one-sentence
 * description and the catalog prints it. The completeness pin means a new knob
 * cannot ship undocumented.
 */

describe("KOREŇ is legible to an agent", () => {
  it("documents EVERY parameter with one sentence", () => {
    expect(bassHarmonicParams.length).toBeGreaterThanOrEqual(18);
    for (const param of bassHarmonicParams) {
      expect(param.description, `${param.id} has no description`).toBeTruthy();
      expect(param.description!.length, `${param.id} description is too short`).toBeGreaterThan(20);
      expect(param.description!.length, `${param.id} description is too long`).toBeLessThan(400);
    }
    // hintHz is deliberately NOT a user knob (engine-fed only) — the catalog
    // must not invent a parameter the definitions do not declare.
    expect(bassHarmonicParams.some((param) => param.id === "hintHz")).toBe(false);
  });

  it("exposes the descriptions and enum options through the REAL catalog tool", async () => {
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_catalog", { subject: "effect", effect: "bassHarmonic" });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("bassHarmonic — GROW (character)");
    const catalogData = result.data as {
      status: string;
      subject: string;
      effect: { type: string; parameters: Array<{ id: string; description: string | null; options: unknown[] }> };
    };
    expect(catalogData.status).toBe("listed");
    expect(catalogData.subject).toBe("effect");
    expect(catalogData.effect.type).toBe("bassHarmonic");
    for (const param of bassHarmonicParams) {
      expect(result.text, `catalog omits the description of ${param.id}`).toContain(param.description!);
      expect(catalogData.effect.parameters.find((entry) => entry.id === param.id)).toMatchObject({
        description: param.description,
        options: param.options ?? [],
      });
    }
    // The semantic extremes an agent needs to choose values.
    expect(result.text).toContain(
      `options: ${KOREN_CHARACTER_LABELS.map((label, value) => `${value}=${label}`).join("|")}`,
    );
    expect(result.text).toContain(
      `options: ${KOREN_KEY_MODE_LABELS.map((label, value) => `${value}=${label}`).join("|")}`,
    );
  });

  it("keeps the catalog honest for an effect without descriptions (no invented text)", async () => {
    // A random OTHER effect must not gain a description just because KOREŇ has
    // them: the catalog prints what the definition carries.
    const host = createHeadlessMcpHost({ document: createDefaultProject() });
    const result = await host.call("kyx_catalog", { subject: "effect", effect: "eq" });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("eq —");
    // KOREŇ's descriptions never leak into another effect's listing.
    expect(result.text).not.toContain("phone speakers can reproduce");
  });
});
