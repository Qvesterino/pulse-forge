export type Tool = "select" | "pencil" | "cut" | "slip" | "stretch" | "mute";

const TOOL_SHORTCUTS: Record<string, Tool> = {
  s: "select",
  p: "pencil",
  c: "cut",
  b: "slip",
  e: "stretch",
  m: "mute",
};

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

  shortcutForKey = (key: string): Tool | null => {
    const lower = key.toLowerCase();
    return TOOL_SHORTCUTS[lower] ?? null;
  };
}
