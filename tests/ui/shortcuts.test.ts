import { describe, expect, it } from "vitest";
import { matchShortcut, SHORTCUTS } from "../../src/ui/shortcuts";

function key(k: string, mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">> = {}): KeyboardEvent {
  return {
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  } as KeyboardEvent;
}

describe("shortcut bindings", () => {
  it("bare digits 1–9 select tracks", () => {
    // Regression: bare 1–5 used to be double-bound (track select AND panel
    // toggle) — the panel entries silently overwrote the track entries in
    // the lookup map, so selecting tracks 1–5 by digit was dead while 6–9
    // still worked.
    for (let n = 1; n <= 9; n++) {
      expect(matchShortcut(key(String(n)))).toBe(`selectTrack${n}`);
    }
  });

  it("Alt+1–5 toggle panels", () => {
    expect(matchShortcut(key("1", { altKey: true }))).toBe("panelMix");
    expect(matchShortcut(key("2", { altKey: true }))).toBe("panelFx");
    expect(matchShortcut(key("3", { altKey: true }))).toBe("panelArr");
    expect(matchShortcut(key("4", { altKey: true }))).toBe("panelMod");
    expect(matchShortcut(key("5", { altKey: true }))).toBe("panelExport");
  });

  it("Escape resolves to stop — selection clearing runs earlier in the app handler", () => {
    // Regression: "stop" and "clearSelection" were both bound to Escape;
    // the later entry overwrote the former, so Esc never stopped transport.
    expect(matchShortcut(key("Escape"))).toBe("stop");
  });

  it("no two primary bindings collide", () => {
    const seen = new Map<string, string>();
    for (const sc of SHORTCUTS) {
      const sig = [
        sc.ctrl ? "C" : ".",
        sc.shift ? "S" : ".",
        sc.alt ? "A" : ".",
        sc.meta ? "M" : ".",
        sc.keyHint.toLowerCase(),
      ].join("|");
      const prev = seen.get(sig);
      expect(prev, `shortcut collision on ${sig}: ${prev} vs ${sc.key}`).toBeUndefined();
      seen.set(sig, sc.key);
    }
  });
});
