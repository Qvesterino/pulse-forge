import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { generatePatternCommand } from "../src/commands/commands";
import { generatePattern, resolveGroove } from "../src/ai/generator";
import { generateDrumPattern } from "../src/ai/drums";
import { buildPadModel, generatePadSequence, quantizeVelocity, dequantizeVelocity, encodeState, decodeLevel, decodePosition } from "../src/ai/markov";
import { getGroovesForGenre, getGrooveById, getStyleNamesForGenre } from "../src/ai/grooves/index";
import { HOUSE_GROOVES } from "../src/ai/grooves/house";
import { TECHNO_GROOVES } from "../src/ai/grooves/techno";
import { TRAP_GROOVES } from "../src/ai/grooves/trap";
import { AMBIENT_GROOVES } from "../src/ai/grooves/ambient";
import type { GenerateOptions, VelocityLevel } from "../src/ai/types";
import { mulberry32 } from "../src/shared/rng";

function makeOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    genre: "house",
    seed: "test-seed-abc",
    stepCount: 16,
    ghostWeight: 0.3,
    microWeight: 0.2,
    velocityVariation: 0.3,
    ...overrides,
  };
}

describe("markov engine", () => {
  it("quantizeVelocity maps 0 to level 0", () => {
    expect(quantizeVelocity(0)).toBe(0);
    expect(quantizeVelocity(-0.1)).toBe(0);
  });

  it("quantizeVelocity maps low velocities to level 1", () => {
    expect(quantizeVelocity(0.1)).toBe(1);
    expect(quantizeVelocity(0.34)).toBe(1);
  });

  it("quantizeVelocity maps mid velocities to level 2", () => {
    expect(quantizeVelocity(0.35)).toBe(2);
    expect(quantizeVelocity(0.69)).toBe(2);
  });

  it("quantizeVelocity maps high velocities to level 3", () => {
    expect(quantizeVelocity(0.7)).toBe(3);
    expect(quantizeVelocity(1.0)).toBe(3);
  });

  it("dequantizeVelocity returns 0 for level 0", () => {
    const rand = mulberry32(42);
    expect(dequantizeVelocity(0, rand)).toBe(0);
  });

  it("dequantizeVelocity returns values in expected ranges", () => {
    for (let seed = 0; seed < 50; seed++) {
      const rand = mulberry32(seed);
      const v1 = dequantizeVelocity(1, rand);
      const v2 = dequantizeVelocity(2, rand);
      const v3 = dequantizeVelocity(3, rand);
      expect(v1).toBeGreaterThanOrEqual(0.2);
      expect(v1).toBeLessThanOrEqual(0.35);
      expect(v2).toBeGreaterThanOrEqual(0.5);
      expect(v2).toBeLessThanOrEqual(0.7);
      expect(v3).toBeGreaterThanOrEqual(0.8);
      expect(v3).toBeLessThanOrEqual(1.0);
    }
  });

  it("encodeState / decodeLevel / decodePosition round-trip", () => {
    for (const level of [0, 1, 2, 3] as VelocityLevel[]) {
      for (let pos = 0; pos < 16; pos++) {
        const encoded = encodeState(level, pos);
        expect(decodeLevel(encoded)).toBe(level);
        expect(decodePosition(encoded)).toBe(pos);
      }
    }
  });

  it("buildPadModel produces valid model from reference patterns", () => {
    const patterns = [
      [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
      [0.85, 0, 0, 0, 0.85, 0, 0, 0, 0.85, 0, 0, 0, 0.85, 0, 0, 0],
    ];
    const model = buildPadModel(0, patterns);
    expect(model.states).toBe(64); // 4 levels * 16 positions
    expect(model.padIndex).toBe(0);
    // Should have some non-zero transitions
    let hasTransitions = false;
    for (let i = 0; i < model.transitions.length; i++) {
      if (model.transitions[i] > 0) { hasTransitions = true; break; }
    }
    expect(hasTransitions).toBe(true);
  });

  it("generatePadSequence produces correct length", () => {
    const patterns = [
      [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
    ];
    const model = buildPadModel(0, patterns);
    const rand = mulberry32(42);
    const seq = generatePadSequence(model, 16, rand);
    expect(seq).toHaveLength(16);
    // All values should be valid levels
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(3);
    }
  });

  it("generatePadSequence is deterministic", () => {
    const patterns = [
      [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
    ];
    const model = buildPadModel(0, patterns);
    const seq1 = generatePadSequence(model, 16, mulberry32(123));
    const seq2 = generatePadSequence(model, 16, mulberry32(123));
    expect(seq1).toEqual(seq2);
  });

  it("generatePadSequence differs with different seeds on rich model", () => {
    // Use multiple varied patterns so the model has enough transitions to differentiate
    const patterns = [
      [0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0, 0.9, 0, 0, 0],
      [0.8, 0, 0.5, 0, 0.8, 0, 0, 0.5, 0.8, 0, 0.5, 0, 0.8, 0, 0, 0.5],
      [0.7, 0.3, 0, 0.3, 0.7, 0, 0.3, 0, 0.7, 0.3, 0, 0.3, 0.7, 0, 0.3, 0],
    ];
    const model = buildPadModel(0, patterns);
    const seq1 = generatePadSequence(model, 16, mulberry32(1));
    const seq2 = generatePadSequence(model, 16, mulberry32(2));
    // With a rich model, different seeds should produce different sequences
    expect(seq1).not.toEqual(seq2);
  });
});

describe("groove library", () => {
  it("has grooves for all four genres", () => {
    expect(getGroovesForGenre("house").length).toBeGreaterThan(0);
    expect(getGroovesForGenre("techno").length).toBeGreaterThan(0);
    expect(getGroovesForGenre("trap").length).toBeGreaterThan(0);
    expect(getGroovesForGenre("ambient").length).toBeGreaterThan(0);
  });

  it("house grooves have correct genre", () => {
    for (const g of HOUSE_GROOVES) {
      expect(g.genre).toBe("house");
    }
  });

  it("techno grooves have correct genre", () => {
    for (const g of TECHNO_GROOVES) {
      expect(g.genre).toBe("techno");
    }
  });

  it("trap grooves have correct genre", () => {
    for (const g of TRAP_GROOVES) {
      expect(g.genre).toBe("trap");
    }
  });

  it("ambient grooves have correct genre", () => {
    for (const g of AMBIENT_GROOVES) {
      expect(g.genre).toBe("ambient");
    }
  });

  it("all grooves have unique IDs", () => {
    const ids = [
      ...HOUSE_GROOVES.map(g => g.id),
      ...TECHNO_GROOVES.map(g => g.id),
      ...TRAP_GROOVES.map(g => g.id),
      ...AMBIENT_GROOVES.map(g => g.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all patterns have 16 steps", () => {
    const all = [...HOUSE_GROOVES, ...TECHNO_GROOVES, ...TRAP_GROOVES, ...AMBIENT_GROOVES];
    for (const groove of all) {
      for (const pattern of groove.patterns) {
        for (const padIndex of groove.activePads) {
          const row = pattern[padIndex];
          if (row) {
            expect(row.length).toBe(16);
          }
        }
      }
    }
  });

  it("getGrooveById finds existing grooves", () => {
    expect(getGrooveById("house.driving")).toBeDefined();
    expect(getGrooveById("techno.minimal")).toBeDefined();
    expect(getGrooveById("trap.classic")).toBeDefined();
    expect(getGrooveById("ambient.drifting")).toBeDefined();
  });

  it("getGrooveById returns undefined for unknown id", () => {
    expect(getGrooveById("unknown.groove")).toBeUndefined();
  });

  it("getStyleNamesForGenre returns style names", () => {
    const houseStyles = getStyleNamesForGenre("house");
    expect(houseStyles).toContain("Driving");
    expect(houseStyles).toContain("Minimal");
    expect(houseStyles.length).toBeGreaterThanOrEqual(4);
  });
});

describe("resolveGroove", () => {
  it("resolves by exact style name", () => {
    const g = resolveGroove("house", "Driving");
    expect(g.name).toBe("Driving");
    expect(g.genre).toBe("house");
  });

  it("resolves by case-insensitive name", () => {
    const g = resolveGroove("techno", "minimal");
    expect(g.name).toBe("Minimal");
  });

  it("resolves by id fragment", () => {
    const g = resolveGroove("trap", "classic");
    expect(g.id).toBe("trap.classic");
  });

  it("falls back to first groove when no style specified", () => {
    const g = resolveGroove("house");
    expect(g.genre).toBe("house");
  });

  it("picks deterministically with rand", () => {
    const rand1 = mulberry32(42);
    const g1 = resolveGroove("house", undefined, rand1);
    const rand2 = mulberry32(42);
    const g2 = resolveGroove("house", undefined, rand2);
    expect(g1.id).toBe(g2.id);
  });
});

describe("drum pattern generation", () => {
  it("generates rows for all active pads", () => {
    const groove = getGrooveById("house.driving")!;
    const options = makeOptions();
    const rand = mulberry32(42);
    const { rows } = generateDrumPattern(groove, options, rand);
    for (const padIndex of groove.activePads) {
      expect(rows[padIndex]).toBeDefined();
      expect(rows[padIndex].length).toBe(16);
    }
  });

  it("generates correct step count", () => {
    const groove = getGrooveById("house.driving")!;
    const options = makeOptions({ stepCount: 32 });
    const rand = mulberry32(42);
    const { rows } = generateDrumPattern(groove, options, rand);
    for (const padIndex of groove.activePads) {
      expect(rows[padIndex]!.length).toBe(32);
    }
  });

  it("all velocities are in range [0, 1]", () => {
    const groove = getGrooveById("techno.driving")!;
    const options = makeOptions();
    const rand = mulberry32(42);
    const { rows } = generateDrumPattern(groove, options, rand);
    for (const row of Object.values(rows)) {
      for (const v of row) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic with same seed", () => {
    const groove = getGrooveById("house.driving")!;
    const options = makeOptions();
    const r1 = generateDrumPattern(groove, options, mulberry32(42));
    const r2 = generateDrumPattern(groove, options, mulberry32(42));
    expect(r1.rows).toEqual(r2.rows);
  });
});

describe("full pattern generation", () => {
  it("generates a valid Pattern object", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const pattern = generatePattern(doc, options);
    expect(pattern.id).toBeTruthy();
    expect(pattern.name).toBe("");
    expect(pattern.stepCount).toBe(16);
    expect(pattern.rows).toBeDefined();
    expect(typeof pattern.rows).toBe("object");
  });

  it("maps pad indices to project pad IDs", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const pattern = generatePattern(doc, options);
    // Should have some rows (mapped from pad indices to pad IDs)
    const rowKeys = Object.keys(pattern.rows);
    expect(rowKeys.length).toBeGreaterThan(0);
    // Pad IDs should look like "track-xxx-pad-yy"
    for (const key of rowKeys) {
      expect(key).toMatch(/track-.+-pad-\d+/);
    }
  });

  it("is deterministic with same options", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const p1 = generatePattern(doc, options);
    const p2 = generatePattern(doc, options);
    expect(p1.rows).toEqual(p2.rows);
    expect(p1.stepMeta).toEqual(p2.stepMeta);
  });

  it("different seeds produce different patterns", () => {
    const doc = createDefaultProject();
    const p1 = generatePattern(doc, makeOptions({ seed: "seed-a" }));
    const p2 = generatePattern(doc, makeOptions({ seed: "seed-b" }));
    // Very high probability they differ
    const same = JSON.stringify(p1.rows) === JSON.stringify(p2.rows);
    expect(same).toBe(false);
  });
});

describe("generatePatternCommand", () => {
  it("creates a valid command", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options);
    expect(cmd.type).toBe("generatePattern");
    expect(cmd.label).toBeTruthy();
  });

  it("execute adds a new pattern", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options);
    const next = cmd.execute(doc);
    expect(next.patterns.length).toBe(doc.patterns.length + 1);
  });

  it("execute sets the new pattern as active", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options);
    const next = cmd.execute(doc);
    const newPattern = next.patterns[next.patterns.length - 1];
    expect(next.activePatternId).toBe(newPattern.id);
  });

  it("execute creates a scene for the new pattern", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options);
    const next = cmd.execute(doc);
    const newPattern = next.patterns[next.patterns.length - 1];
    const scene = next.scenes.find(s => s.patternId === newPattern.id);
    expect(scene).toBeDefined();
  });

  it("undo removes the new pattern", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options);
    const next = cmd.execute(doc);
    const restored = cmd.undo(next);
    expect(restored.patterns.length).toBe(doc.patterns.length);
  });

  it("undo restores activePatternId", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options);
    const next = cmd.execute(doc);
    const restored = cmd.undo(next);
    expect(restored.activePatternId).toBe(doc.activePatternId);
  });

  it("uses custom pattern name when provided", () => {
    const doc = createDefaultProject();
    const options = makeOptions();
    const cmd = generatePatternCommand(doc, options, "My Custom Beat");
    const next = cmd.execute(doc);
    const newPattern = next.patterns[next.patterns.length - 1];
    expect(newPattern.name).toBe("My Custom Beat");
  });

  it("generates pattern name from genre and seed when no name given", () => {
    const doc = createDefaultProject();
    const options = makeOptions({ seed: "abc123" });
    const cmd = generatePatternCommand(doc, options);
    const next = cmd.execute(doc);
    const newPattern = next.patterns[next.patterns.length - 1];
    expect(newPattern.name).toContain("house");
  });
});
