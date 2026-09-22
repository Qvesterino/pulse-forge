import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeSource = readFileSync(resolve(process.cwd(), "src/generative/runtime.ts"), "utf8");
const schedulerSource = readFileSync(resolve(process.cwd(), "src/scheduler/Scheduler.ts"), "utf8");

describe("generative runtime architecture", () => {
  it("keeps provider sessions outside Scheduler ownership", () => {
    expect(runtimeSource).not.toMatch(/from ["']\.\.\/scheduler\/Scheduler["']/u);
    expect(runtimeSource).toMatch(/buildGenerativeInput/u);
    expect(runtimeSource).toMatch(/session\.updateInput/u);
    expect(schedulerSource).not.toMatch(/GenerativeAudioSession|GenerativeRuntime|createMrt2/iu);
  });

  it("uses the shared AudioEngine generative attach/detach boundary", () => {
    expect(runtimeSource).toMatch(/attachGenerativeSource/u);
    expect(runtimeSource).toMatch(/detachGenerativeSource/u);
    expect(runtimeSource).not.toMatch(/createGain\(|createStereoPanner\(/u);
  });
});
