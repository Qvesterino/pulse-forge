import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("src/mcp/tools.ts", "utf8");
if (s.includes("planReferenceMastering")) {
  console.log("ALREADY APPLIED");
  process.exit(0);
}

// 1) Import the reference planner.
s = s.replace(
  `import { planMasterSettings } from "./master-assistant";`,
  `import { planMasterSettings, planReferenceMastering, type ReferencePair } from "./master-assistant";`,
);

// 2) In the assist branch: when record.reference carries a reference
//    measurement, plan toward IT (the F2 §2.2 rule lives in the planner).
const assistPlan = `    const plan = planMasterSettings({
      lufs,
      peakDb,
      crestDb,
      correlation,
      targetLufs:
        typeof record.targetLufs === "number"
          ? record.targetLufs
          : profileFor(typeof record.profile === "string" ? record.profile : undefined)?.targetLufs,
    });`;
const assistPlanNew = `    const referenceIn = record.reference as
      | { lufs?: number; crestDb?: number; correlation?: number; hfShare?: number; lowEndShare?: number }
      | undefined;
    const plan =
      referenceIn && typeof referenceIn === "object"
        ? planReferenceMastering({
            mine: {
              lufs,
              crestDb,
              correlation,
              hfShare: typeof referenceIn.hfShare === "number" ? 1 - referenceIn.hfShare : 0.2,
              lowEndShare: typeof referenceIn.lowEndShare === "number" ? referenceIn.lowEndShare : 0.25,
            },
            reference: {
              lufs: typeof referenceIn.lufs === "number" ? referenceIn.lufs : null,
              crestDb: typeof referenceIn.crestDb === "number" ? referenceIn.crestDb : 11,
              correlation: typeof referenceIn.correlation === "number" ? referenceIn.correlation : null,
              hfShare: typeof referenceIn.hfShare === "number" ? referenceIn.hfShare : 0.2,
              lowEndShare: typeof referenceIn.lowEndShare === "number" ? referenceIn.lowEndShare : 0.25,
            },
            targetLufs: typeof record.targetLufs === "number" ? record.targetLufs : undefined,
          } satisfies ReferencePair & { mine: { hfShare: number; lowEndShare: number } })
        : planMasterSettings({
            lufs,
            peakDb,
            crestDb,
            correlation,
            targetLufs:
              typeof record.targetLufs === "number"
                ? record.targetLufs
                : profileFor(typeof record.profile === "string" ? record.profile : undefined)?.targetLufs,
          });`;
if (!s.includes(assistPlan)) {
  console.error("NO ASSIST PLAN ANCHOR");
  process.exit(1);
}
s = s.replace(assistPlan, assistPlanNew);

// 3) Schema: the reference object prop on assist.
s = s.replace(
  `        action: {
          type: "string",
          enum: ["save", "list", "compare", "restore"],
          description: "For op:ab — snapshot action",
        },`,
  `        action: {
          type: "string",
          enum: ["save", "list", "compare", "restore"],
          description: "For op:ab — snapshot action",
        },
        reference: {
          type: "object",
          description:
            "For op:assist — the REFERENCE measurement (lufs, crestDb, correlation, hfShare, lowEndShare). " +
            "The planner moves toward the measured DIFFERENCE, never the reference's absolute shape.",
          properties: {
            lufs: { type: "number" },
            crestDb: { type: "number" },
            correlation: { type: "number", minimum: -1, maximum: 1 },
            hfShare: { type: "number", minimum: 0, maximum: 1 },
            lowEndShare: { type: "number", minimum: 0, maximum: 1 },
          },
        },`,
);

writeFileSync("src/mcp/tools.ts", s);
console.log("OK");
