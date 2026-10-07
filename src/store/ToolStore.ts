/**
 * The editing tool state — the third pub/sub store of the architecture triad
 * (ProjectStore / SelectionStore / ToolStore).
 *
 * The union is DELIBERATELY two entries. The original six ("pencil", "slip",
 * "stretch", "mute"…) were aspirational: nothing consumed them for months,
 * the S/P/C/B/E/M keybinds silently swallowed letters, and the gestures those
 * names described shipped as MODIFIERS instead (Alt+edge stretch, Alt+body
 * slip — modifier-gestures are the PT-style interaction this editor uses).
 * A tool mode exists only when a click actually does something the drag
 * system cannot.
 *
 * `cut` earns its place (ADR 0025 made split timeline-wide): clicking a clip
 * — scene OR audio — splits it at the click position, which a drag gesture
 * cannot express. `select` is the null tool every mode returns to (Escape).
 *
 * Keyboard shortcuts live in App.tsx with every other shortcut (V select,
 * C cut), NOT here — the store is state, not a keymap; the old
 * `shortcutForKey` table was the dead-map anti-pattern that got removed.
 */
export type Tool = "select" | "cut";

export class ToolStore {
  private tool: Tool = "select";
  private listeners = new Set<() => void>();

  getTool = (): Tool => this.tool;

  setTool = (tool: Tool): void => {
    if (this.tool === tool) return;
    this.tool = tool;
    this.emit();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
