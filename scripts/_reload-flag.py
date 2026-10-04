# C7.6 patch: reloaded flag on hydrated checkpoints + full-chain fix
import io

p = "src/mcp/tools.ts"
s = io.open(p, encoding="utf-8").read()

# 1) McpCheckpoint gains reloaded flag
old = """interface McpCheckpoint {
  doc: ProjectDocument;
  projectId: string;
  stepsAtSave: number;
  summary: string;
  auto: boolean;
}"""
new = """interface McpCheckpoint {
  doc: ProjectDocument;
  projectId: string;
  stepsAtSave: number;
  summary: string;
  auto: boolean;
  /** True when hydrated from IDB after a reload — the steps-since
   * relationship is inherently session-scoped and resets here. */
  reloaded?: boolean;
}"""
assert old in s, "interface"
s = s.replace(old, new, 1)

# 2) hydrateCheckpoints: mark hydrated entries
old = """      checkpoints.set(record.name, {
        doc: record.doc,
        projectId,
        stepsAtSave: ctx.undoStackLength(),
        summary: record.label,
        auto: record.auto,
      });"""
new = """      checkpoints.set(record.name, {
        doc: record.doc,
        projectId,
        stepsAtSave: ctx.undoStackLength(),
        summary: record.label,
        auto: record.auto,
        reloaded: true,
      });"""
assert old in s, "hydrate set"
s = s.replace(old, new, 1)

# 3) list read-back: show reloaded instead of misleading 0 steps
old = """      const stepsSince = Math.max(0, ctx.undoStackLength() - cp.stepsAtSave);
      const scope = cp.projectId === projectId ? "" : " (other project)";
      lines.push(
        `${name}${cp.auto ? " (auto)" : ""} \u00b7 ${cp.summary} \u00b7 ${stepsSince} step(s) since${scope}`,
      );"""
new = """      const stepsSince = Math.max(0, ctx.undoStackLength() - cp.stepsAtSave);
      const scope = cp.projectId === projectId ? "" : " (other project)";
      const timing = cp.reloaded
        ? "\u21bb reloaded (steps reset)"
        : `${stepsSince} step(s) since`;
      lines.push(
        `${name}${cp.auto ? " (auto)" : ""} \u00b7 ${cp.summary} \u00b7 ${timing}${scope}`,
      );"""
assert old in s, "list read-back"
s = s.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("reloaded flag wired")
