import { describe, expect, it } from "vitest";
import { parseSfz } from "../src/sample-library/sfz";
import { planSfzInstrumentImport, type SfzImportFile } from "../src/sample-library/sfz-import";

/**
 * USER SFZ LIBRARY IMPORT — parser + planner contracts. VSCO2 CE proved the
 * state-machine approach in production conversion (scripts/convert-vsco2.mjs
 * shares the algorithm); these vectors pin the shared parser + the planner's
 * resolution/plan rules for the in-app user import.
 */

const SFZ = [
  "<control>",
  "default_path=Strings\\Cello Section\\susVib\\",
  "",
  "<global>",
  "ampeg_release=0.8",
  "",
  "<group>",
  "lovel=0 hivel=60",
  "",
  "<region>",
  "sample=susvib_A2_v1.wav",
  "lokey=45",
  "hikey=48",
  "pitch_keycenter=46",
  "",
  "<region>",
  "sample=susvib_C4_v1.wav",
  "lokey=59",
  "hikey=62",
  "pitch_keycenter=60",
  "",
  "<group>",
  "lovel=61 hivel=127",
  "",
  "<region>",
  "sample=susvib_A2_v2.wav",
  "lokey=45",
  "hikey=48",
  "pitch_keycenter=46",
  "",
  "<region>",
  "sample=susvib_C4_v2.wav",
  "lokey=59",
  "hikey=62",
  "pitch_keycenter=60",
].join("\r\n");

const files: SfzImportFile[] = [
  { name: "MyLib/Strings/Cello Section/susVib/susvib_A2_v1.wav", data: new ArrayBuffer(8) },
  { name: "MyLib/Strings/Cello Section/susVib/susvib_A2_v2.wav", data: new ArrayBuffer(8) },
  { name: "MyLib/Strings/Cello Section/susVib/susvib_C4_v1.wav", data: new ArrayBuffer(8) },
  { name: "MyLib/Strings/Cello Section/susVib/susvib_C4_v2.wav", data: new ArrayBuffer(8) },
];

describe("parseSfz (shared state-machine parser)", () => {
  it("collects default_path + regions with opcodes on their own lines", () => {
    const doc = parseSfz(SFZ);
    expect(doc.defaultPath).toBe("Strings/Cello Section/susVib/");
    expect(doc.regions.length).toBe(4);
    expect(doc.regions[0]).toEqual({
      sample: "Strings/Cello Section/susVib/susvib_A2_v1.wav",
      lokey: 45,
      hikey: 48,
      keycenter: 46,
      lovel: 0,
      hivel: 60,
    });
  });

  it("handles single-line regions (opcode on the header line)", () => {
    const doc = parseSfz("<region> sample=x.wav lokey=60 hikey=60 pitch_keycenter=60 lovel=0 hivel=127");
    expect(doc.regions.length).toBe(1);
    expect(doc.regions[0].keycenter).toBe(60);
  });

  it("strips // comments and tolerates unknown opcodes", () => {
    const doc = parseSfz(
      ["<region>", "sample=a.wav // the main take", "lokey=60", "weird_future_opcode=42", "hikey=60"].join("\r\n"),
    );
    expect(doc.regions.length).toBe(1);
    expect(doc.regions[0].lokey).toBe(60);
  });
});

describe("planSfzInstrumentImport", () => {
  it("plans one layer per region with root/keyzone/velocity from the SFZ", () => {
    const plan = planSfzInstrumentImport("MyCello.sfz", SFZ, files);
    expect(plan.instrumentName).toBe("MyCello");
    expect(plan.samplePrefix).toBe("user.sfz.mycello");
    expect(plan.regions.length).toBe(4);
    // Key 46, zone 1 (lovel 0..60): root 46, window 0..61/127.
    const first = plan.regions[0];
    expect(first.sampleId).toBe("user.sfz.mycello.k46z1");
    expect(first.layer.root).toBe(46);
    expect(first.layer.minPitch).toBe(45);
    expect(first.layer.maxPitch).toBe(48);
    expect(first.layer.min).toBeCloseTo(0, 5);
    expect(first.layer.max).toBeCloseTo(61 / 127, 3);
  });

  it("resolves samples by case-insensitive suffix of the provided paths", () => {
    const plan = planSfzInstrumentImport("MyCello.sfz", SFZ, files);
    expect(plan.missing.length).toBe(0);
    expect(plan.regions.every((r) => r.fileName.length > 0)).toBe(true);
  });

  it("reports regions whose sample file was not provided", () => {
    const plan = planSfzInstrumentImport("MyCello.sfz", SFZ, [files[2]!]);
    expect(plan.missing.length).toBeGreaterThan(0);
    expect(plan.missing[0].fileName).toContain("susvib_A2_v1.wav");
  });
});
