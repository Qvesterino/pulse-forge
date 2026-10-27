import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveShortcuts,
  matchShortcut,
  panelIdOfShortcut,
  resetShortcutBindings,
  setShortcutBinding,
  shortcutDisplayBindings,
  SHORTCUTS,
  EDITOR_SHORTCUTS,
} from "../../src/ui/shortcuts";

function key(
  k: string,
  mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">> = {},
): KeyboardEvent {
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
  afterEach(() => {
    resetShortcutBindings();
  });

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
    expect(matchShortcut(key("9", { altKey: true }))).toBe("panelMaster");
  });

  it("Escape resolves to stop — selection clearing runs earlier in the app handler", () => {
    // Regression: "stop" and "clearSelection" were both bound to Escape;
    // the later entry overwrote the former, so Esc never stopped transport.
    expect(matchShortcut(key("Escape"))).toBe("stop");
  });

  it("Ctrl+D resolves to contextual duplicate selection", () => {
    expect(matchShortcut(key("d", { ctrlKey: true }))).toBe("duplicateSelection");
  });

  it("remaps a global action and resets it to its original binding", () => {
    const result = setShortcutBinding("playPause", {
      keyHint: "u",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(result).toMatchObject({ ok: true, persisted: true });
    expect(matchShortcut(key("U", { ctrlKey: true, shiftKey: true }))).toBe("playPause");
    expect(matchShortcut(key(" "))).toBeNull();
    const play = getActiveShortcuts().find(({ key: shortcutKey }) => shortcutKey === "playPause");
    expect(play).toBeDefined();
    expect(shortcutDisplayBindings(play!)).toEqual(["Ctrl + Shift + U"]);

    expect(setShortcutBinding("playPause", null)).toMatchObject({ ok: true, persisted: true });
    expect(matchShortcut(key(" "))).toBe("playPause");
  });

  it("rejects plain keys, browser-reserved chords, global collisions and editor collisions", () => {
    const plain = setShortcutBinding("playPause", {
      keyHint: "u",
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    });
    expect(plain).toMatchObject({ ok: false });

    const browser = setShortcutBinding("playPause", {
      keyHint: "t",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(browser).toMatchObject({ ok: false, message: expect.stringContaining("browser") });

    const global = setShortcutBinding("playPause", {
      keyHint: "z",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(global).toMatchObject({ ok: false, message: expect.stringContaining("Redo") });

    // The editor-action collision: every Ctrl+Shift+letter chord is owned by
    // a global shortcut or browser-reserved today, so the editor branch is
    // only reachable through the self-skip — rebinding `ungroupClips` onto
    // Ctrl+Shift+G skips the global list's own entry and lands on the
    // "Group / ungroup the selected clips" editor action. (playPause →
    // Ctrl+Shift+V used to probe this until "Vary active pattern" took the
    // chord and the global check began answering first.)
    const editor = setShortcutBinding("ungroupClips", {
      keyHint: "g",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    });
    expect(editor).toMatchObject({ ok: false, message: expect.stringContaining("editor action") });
    expect(matchShortcut(key(" "))).toBe("playPause");
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

  it("every panel shortcut maps to a real panel id", () => {
    // Regression: Alt+5 derived its target by slicing the shortcut name
    // ("panelExport" → "export"), but the app's panel id is "exp" — the key
    // matched nothing and silently closed the dock instead of opening Export.
    const panelShortcuts = SHORTCUTS.filter((sc) => sc.key.startsWith("panel"));
    expect(panelShortcuts.length).toBeGreaterThanOrEqual(5);
    for (const sc of panelShortcuts) {
      expect(panelIdOfShortcut(sc.key as never), `${sc.key} must map to a panel id`).toBeTypeOf("string");
    }
    expect(panelIdOfShortcut("panelExport")).toBe("exp");
    expect(panelIdOfShortcut("panelMix")).toBe("mixer");
  });

  it("documents the range consolidation binding in the editor shortcuts", () => {
    // Ctrl+Shift+C consolidates the selected range to one audio clip
    // (src/ui/App.tsx) and worked, but appeared in NO help surface: not in the
    // shortcut registry, not in EDITOR_SHORTCUTS, not in the command palette.
    const row = EDITOR_SHORTCUTS.find((entry) => entry.bindings.includes("Ctrl + Shift + C"));
    expect(row, "Ctrl+Shift+C must be documented").toBeDefined();
    expect(row?.area).toBe("Arrangement keys");
    expect(row?.label.toLowerCase()).toContain("consolidate");
  });
});
