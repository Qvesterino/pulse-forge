import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { factorySampleIdsOf } from "../src/sample-library/requiredIds";
import { FACTORY_ASSETS } from "../src/sample-library/manifest";

/**
 * The factory catalogue (155 synthesized assets) is rendered OFF the boot's
 * critical path.
 *
 * MEASURED, before the change: the catalogue build cost 734 ms while the
 * WHOLE service boot took 650 ms — the boot WAS the catalogue. The context
 * creation is only 12 % of that cost (the render is 88 %), and a single
 * context for all 155 assets was SLOWER than 155 separate ones (2309 ms vs
 * 774 ms), so "fewer OfflineAudioContexts" is not the lever — "less audio
 * before the user can act" is.
 *
 * The contract this file locks:
 *   1. a document says which samples it needs (BEHAVIOURAL, Node-pure)
 *   2. the boot does NOT wait for the catalogue (STRUCTURAL)
 *   3. a project open awaits exactly the document's samples (STRUCTURAL)
 *   4. an export waits for the whole catalogue (STRUCTURAL)
 *   5. ensure renders only what is missing and JOINS an in-flight render
 *      (STRUCTURAL — the render itself needs an AudioContext, so the
 *      browser measurement is the behavioural half)
 *   6. the catalogue wait also covers a render that is still IN FLIGHT —
 *      the background build's promise does not include a sample a project
 *      open asked for on its own (STRUCTURAL)
 *
 * Every structural contract carries a mutation that has to break it: a guard
 * that cannot fail is not a guard.
 */
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const servicesSource = read("../src/services.ts");
const rendererSource = read("../src/rendering/renderer.ts");
const factorySource = read("../src/sample-library/factory.ts");

interface StructuralContract {
  name: string;
  holds: (source: string) => boolean;
  mutate: (source: string) => string;
}

const structuralContracts: StructuralContract[] = [
  {
    name: "the boot starts the catalogue build WITHOUT awaiting it",
    holds: (s) => /const bank = new SampleBank\(\);\s*\n\s*startFactoryBankBuild\(bank\);/.test(s),
    mutate: (s) =>
      s.replace(
        /const bank = new SampleBank\(\);\s*\n\s*startFactoryBankBuild\(bank\);/,
        "const bank = new SampleBank();\n  await generateFactoryBankInto(bank);",
      ),
  },
  {
    name: "a project open awaits the document's own samples",
    holds: (s) => /await ensureFactorySamples\(bank, factorySampleIdsOf\(store\.doc\)\);/.test(s),
    mutate: (s) => s.replace(/await ensureFactorySamples\(bank, factorySampleIdsOf\(store\.doc\)\);/, ""),
  },
  {
    name: "an export waits for the WHOLE catalogue (no timeout)",
    holds: (s) => /await factoryBankReady\(bank\);/.test(s) && !/factoryBankReadyWithin/.test(s),
    mutate: (s) => s.replace(/await factoryBankReady\(bank\);/, "/* no wait */"),
  },
  {
    name: "ensure renders only what is MISSING and joins an in-flight render",
    holds: (s) =>
      /if \(bank\.has\(asset\.id\)\) continue;/.test(s) &&
      /const existing = state\.assets\.get\(asset\.id\);/.test(s) &&
      /state\.assets\.set\(asset\.id, render\);/.test(s),
    mutate: (s) => s.replace(/if \(bank\.has\(asset\.id\)\) continue;/, ""),
  },
  {
    name: "the catalogue wait ALSO covers a render that is still in flight",
    holds: (s) =>
      /export function factoryBankReady\(bank: SampleBank\): Promise<void> \{[\s\S]*?state\.assets\.values\(\)/.test(s),
    mutate: (s) => s.replace(/const inFlight = \[\.\.\.state\.assets\.values\(\)\];/, ""),
  },
];

describe("the factory catalogue is rendered off the boot's critical path", () => {
  it("a document says which factory samples it needs — and it is a SUBSET of the catalogue", () => {
    const doc = createProjectFromTemplate("house");
    const ids = factorySampleIdsOf(doc);
    expect(ids.length).toBeGreaterThan(0);
    // The house template needs the drum kit and the melodic tracks' samples —
    // a handful, not the whole catalogue. This is the whole point: the boot
    // renders what the project needs, the rest arrives in the background.
    expect(ids.length).toBeLessThan(FACTORY_ASSETS.length / 3);
    const catalogue = new Set(FACTORY_ASSETS.map((a) => a.id));
    for (const id of ids) {
      expect(id.startsWith("factory.")).toBe(true);
      expect(catalogue.has(id)).toBe(true);
    }
  });

  it("a document with no factory references asks for nothing", () => {
    expect(factorySampleIdsOf(null)).toEqual([]);
    expect(factorySampleIdsOf({ nope: "not-a-sample" } as never)).toEqual([]);
  });

  for (const contract of structuralContracts) {
    it(`contract: ${contract.name}`, () => {
      const source =
        contract.name.includes("boot") || contract.name.includes("project open")
          ? servicesSource
          : contract.name.includes("export")
            ? rendererSource
            : factorySource;
      expect(contract.holds(source)).toBe(true);
      // NEGATIVE CONTROL: the mutation has to break the contract.
      expect(contract.holds(contract.mutate(source))).toBe(false);
    });
  }
});
