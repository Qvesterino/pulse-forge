import { describe, it, expect } from "vitest";
import { parsePercent } from "../src/intent/percent";

describe("parsePercent (EN+SK)", () => {
  it("SK digits: o 10 % / o 10 percent", () => {
    expect(parsePercent("zvýš hlasitosť 808s o 10%")).toBe(10);
    expect(parsePercent("zníž basu o 25 percent")).toBe(25);
    expect(parsePercent("viac delayu na leade o 20 %")).toBe(20);
    expect(parsePercent("stíš to o 5 procent")).toBe(5);
  });

  it("EN digits: by 10 percent / +10% / pct", () => {
    expect(parsePercent("turn up the bass by 10 percent")).toBe(10);
    expect(parsePercent("more reverb +30%")).toBe(30);
    expect(parsePercent("less delay 15pct")).toBe(15);
  });

  it("sign is direction-neutral (words win), zero is a no-op", () => {
    expect(parsePercent("zníž basu o -10%")).toBe(10);
    expect(parsePercent("zvýš basu o 0%")).toBeNull();
  });

  it("clamps to 1..100", () => {
    expect(parsePercent("úplne to vypni o 500%")).toBe(100);
    expect(parsePercent("o 1%")).toBe(1);
  });

  it("word fractions: polovicu / tretinu / double", () => {
    expect(parsePercent("stíš basu o polovicu")).toBe(50);
    expect(parsePercent("turn it down by half")).toBe(50);
    expect(parsePercent("zdvojnásob reverb")).toBe(100);
    expect(parsePercent("double the delay")).toBe(100);
  });

  it("ignores bare numbers (bpm, bars, lufs)", () => {
    expect(parsePercent("dark techno at 140")).toBeNull();
    expect(parsePercent("tempo na 128")).toBeNull();
    expect(parsePercent("16-bar intro")).toBeNull();
    expect(parsePercent("loudness na -9")).toBeNull();
    expect(parsePercent("zvýš basu")).toBeNull();
  });
});
