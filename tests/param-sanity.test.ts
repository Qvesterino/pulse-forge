import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EFFECT_META, formatMs, formatSecMs } from "../src/effects/definitions";

/**
 * Session A (quality backlog) — plugin parameter sanity pins for the fixed
 * items: seconds-stored dynamics params display in ms, the stutter SMOOTH
 * param now speaks the node's language (seconds), and the label fixes
 * (tremolo blend, sidechain OFF, utility DC BLOCK wired).
 */

describe("param formatters (GOAL-backlog A2)", () => {
  it("formatSecMs scales seconds to ms; formatMs stays raw for ms-stored params", () => {
    expect(formatSecMs(0.003)).toBe("3 ms");
    expect(formatSecMs(0.2)).toBe("200 ms");
    expect(formatSecMs(1)).toBe("1000 ms");
    expect(formatMs(12)).toBe("12 ms");
  });

  it("every unit:'s' param uses formatSecMs (no raw-seconds display regression)", () => {
    const source = readFileSync(resolve(process.cwd(), "src/effects/definitions.ts"), "utf8");
    const secLines = source.match(/unit: "s", format: [A-Za-z]+/g) ?? [];
    expect(secLines.length).toBeGreaterThan(10);
    for (const line of secLines) {
      // formatSec (display in seconds) is a legitimate choice; the bug class
      // being pinned is a seconds value routed through the raw-ms formatter.
      expect(line, `seconds param must not use the raw-ms formatter: ${line}`).not.toContain("formatMs");
      expect(line, `seconds param must not use Hz/pct formatters: ${line}`).not.toMatch(/format(Pct|Hz)/);
    }
  });
});

describe("stutter SMOOTH contract (GOAL-backlog A1)", () => {
  it("speaks the node's language: seconds, clamped to the processor's 0..0.02", () => {
    const smooth = EFFECT_META.stutter.params.find((p) => p.id === "smooth")!;
    expect(smooth.min).toBe(0);
    expect(smooth.max).toBe(0.02);
    expect(smooth.default).toBe(0.003);
    expect(smooth.unit).toBe("s");
    expect(smooth.format!(smooth.default)).toBe("3 ms");
  });

  it("node passes the param through unchanged (seconds in, seconds out)", () => {
    const nodeSource = readFileSync(resolve(process.cwd(), "src/audio-worklets/stutter-node.ts"), "utf8");
    expect(nodeSource).toContain("instance.params.smooth ?? 0.003");
    expect(nodeSource).not.toMatch(/smooth[^;]*\/ ?1000/); // no ms→s rescale — the param IS seconds
  });
});

describe("label fixes (GOAL-backlog A8)", () => {
  it("tremolo SHAPE no longer claims a triangle that does not exist", () => {
    const shape = EFFECT_META.tremolo.params.find((p) => p.id === "shape")!;
    const labels = [0, 0.5, 1].map((v) => shape.format!(v));
    expect(labels[0]).toBe("Sine");
    expect(labels[1]).toBe("Blend");
    expect(labels[2]).toBe("Square");
    expect(labels.join(" ")).not.toContain("Tri");
  });

  it("sidechain SPLIT shows OFF in the full-band zone (≤10 Hz)", () => {
    const split = EFFECT_META.sidechain.params.find((p) => p.id === "splitFreq")!;
    expect(split.format!(0)).toBe("OFF");
    expect(split.format!(5)).toBe("OFF");
    expect(split.format!(120)).toBe("120 Hz");
  });
});

describe("utility DC BLOCK (GOAL-backlog A3)", () => {
  it("param exists and the runtime handles it (source pin — no more dead knob)", () => {
    const dcBlock = EFFECT_META.utility.params.find((p) => p.id === "dcBlock")!;
    expect(dcBlock).toBeDefined();
    const registrySource = readFileSync(resolve(process.cwd(), "src/effects/registry.ts"), "utf8");
    expect(registrySource).toContain('case "dcBlock"');
    expect(registrySource).toContain("applyDcBlock");
  });
});
