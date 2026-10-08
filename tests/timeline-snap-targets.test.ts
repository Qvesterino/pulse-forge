import { afterEach, describe, expect, it } from "vitest";
import { SnapController, snapBarToTargets } from "../src/ui/snap";

/**
 * SNAP TARGETS + CONTROLLER (snap engine v1 doplnok k existujúcemu gridu).
 *
 * Grid-only snapping už prichádza z cf4d212e; tieto testy pinapri novú
 * vrstvu: SECONDARY TARGETS (clip edges / markery / loop hranice) ktoré
 * "chytia" pointer v rámci prahu a predbehnú grid len tým, že sú bližšie —
 * a SnapController, aby toolbar select aj J klávesa zdieľali jeden stav.
 *
 * Kontrakty:
 *  ST1 grid zostáva defaultnou odpoveďou — target vyhrá len tým, že je blíž
 *  ST2 prah je tvrdý strop — target za prahom sa ignoruje (žiadne magnet
 *      na diaľku)
 *  ST3 grid OFF = úplne voľno — targets sú súčasťou snappingu, nie
 *      vždy-zapnutá vrstva
 *  SC1 controller: setGrid/toggleEnabled off↔restore, subscribe emituje,
 *      posledný ne-off grid sa pamätá
 */

const THRESHOLD = 0.25; // bars — v UI: 8 px pri 32 px/bar

describe("ST1/ST2 snap targets vs grid", () => {
  it("bez targetov v prahu platí grid", () => {
    // grid 1/1: 1.45 → 1.0 je bližšie ako 2.0
    expect(snapBarToTargets(1.45, 1, [], THRESHOLD)).toBe(1);
    // polovičná vzdialenosť: 1.6 → 2.0
    expect(snapBarToTargets(1.6, 1, [], THRESHOLD)).toBe(2);
  });

  it("target v prahu a bližšie ako grid predbehne grid", () => {
    // susedov edge na 1.5: pointer na 1.45 je od neho 0.05, od gridu 0.45
    expect(snapBarToTargets(1.45, 1, [1.5], THRESHOLD)).toBe(1.5);
    // aj keď grid kladie iný kandidát: 1.6 s targetom 1.5 → 1.5 (0.1 < 0.4)
    expect(snapBarToTargets(1.6, 1, [1.5], THRESHOLD)).toBe(1.5);
  });

  it("target za prahom sa ignoruje (žiadny magnet na diaľku)", () => {
    // 1.2: od targetu 1.5 je to 0.3 > 0.25 → grid 1.0 vyhrá
    expect(snapBarToTargets(1.2, 1, [1.5], THRESHOLD)).toBe(1);
    // target presne na prahu sa ešte chytí (<=)
    expect(snapBarToTargets(1.25, 1, [1.5], THRESHOLD)).toBe(1.5);
  });

  it("bližší z viacerých targetov vyhrá; non-finite sa preskočí", () => {
    expect(snapBarToTargets(1.44, 1, [1.5, 2.5, Number.NaN], THRESHOLD)).toBe(1.5);
    expect(snapBarToTargets(2.46, 1, [1.5, 2.5], THRESHOLD)).toBe(2.5);
  });
});

describe("ST3 grid off = free", () => {
  it("targets sa pri vypnutom gride ignorujú", () => {
    expect(snapBarToTargets(1.45, null, [1.5], THRESHOLD)).toBe(1.45);
    expect(snapBarToTargets(1.5001, null, [1.5, 7.25], THRESHOLD)).toBe(1.5001);
  });
});

describe("SC1 SnapController", () => {
  afterEach(() => {
    // Singleton — vráť predvolený stav pre ďalší test.
    controller.setGrid("off");
  });

  const controller = new SnapController();

  it("setGrid mení hodnotu a emituje; toggle sa pamäta posledný ne-off grid", () => {
    let emissions = 0;
    const unsubscribe = controller.subscribe(() => (emissions += 1));
    controller.setGrid("1/8");
    expect(controller.getGrid()).toBe("1/8");
    expect(emissions).toBe(1);
    // set na rovnakú hodnotu neemituje (no-op guard).
    controller.setGrid("1/8");
    expect(emissions).toBe(1);

    controller.toggleEnabled();
    expect(controller.getGrid()).toBe("off");
    controller.toggleEnabled();
    expect(controller.getGrid()).toBe("1/8"); // obnovené — nie default "1"
    // Toggle z off s historiou "1/8" zasa obnoví 1/8, aj keď iný test nastavil 1.
    controller.setGrid("1");
    controller.setGrid("off");
    controller.toggleEnabled();
    expect(controller.getGrid()).toBe("1");
    unsubscribe();
  });

  it("setGrid perzistuje cez storeSnapGrid (localStorage)", () => {
    controller.setGrid("1/16");
    expect(localStorage.getItem("pf:arr-snap")).toBe("1/16");
    controller.setGrid("off");
    expect(localStorage.getItem("pf:arr-snap")).toBe("off");
  });
});
