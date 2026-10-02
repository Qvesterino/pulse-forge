# C7 patch v2: bounded by executeCheckpointTool's balanced close
import io

p = "src/mcp/tools.ts"
s = io.open(p, encoding="utf-8").read()

start = s.index("/** \u2500\u2500 CHECKPOINTS (agent time machine")
fn_marker = "function executeCheckpointTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {"
fn_idx = s.index(fn_marker)
open_idx = s.index("{", fn_idx)
depth = 0
i = open_idx
while i < len(s):
    c = s[i]
    if c == "{":
        depth += 1
    elif c == "}":
        depth -= 1
        if depth == 0:
            section_end = i + 1
            break
    i += 1

NEW_TAIL = """

/** C7: merge the project's durable checkpoints into the live map (once per
 * project, first checkpoint use). Persisted entries restart their
 * steps-since counter at the current stack depth \u2014 reload resets that
 * relationship by definition. */
async function hydrateCheckpoints(ctx: McpToolContext, projectId: string): Promise<void> {
  if (hydratedProjects.has(projectId)) return;
  hydratedProjects.add(projectId);
  try {
    const repo = await getCheckpointRepo();
    if (repo == null) return;
    const persisted = await repo.list(projectId);
    for (const record of [...persisted].reverse()) {
      if (checkpoints.has(record.name)) continue;
      checkpoints.set(record.name, {
        doc: record.doc,
        projectId,
        stepsAtSave: ctx.undoStackLength(),
        summary: record.label,
        auto: record.auto,
      });
    }
  } catch {
    // persistence unavailable \u2014 session-only mode, already recorded
  }
}

function checkpointProjectId(ctx: McpToolContext): string {
  const doc = ctx.getDoc();
  return doc.id !== "" ? doc.id : `unnamed:${doc.name}`;
}
"""

s = s[:section_end] + NEW_TAIL + s[section_end:]

# ── now upgrade the section pieces in place ──

# 1) interface + state: add projectId + repo/hydration machinery
old = """interface McpCheckpoint {
  doc: ProjectDocument;
  stepsAtSave: number;
  summary: string;
  auto: boolean;
}

const checkpoints = new Map<string, McpCheckpoint>();
let checkpointCounter = 0;

/** Test hook \u2014 the store is module-level by design (per-window session). */
export function resetMcpCheckpoints(): void {
  checkpoints.clear();
  checkpointCounter = 0;
}"""
new = """interface McpCheckpoint {
  doc: ProjectDocument;
  projectId: string;
  stepsAtSave: number;
  summary: string;
  auto: boolean;
}

const checkpoints = new Map<string, McpCheckpoint>();
let checkpointCounter = 0;
/** Projects whose durable checkpoints were already merged into the map. */
const hydratedProjects = new Set<string>();

export interface CheckpointRepoLike {
  put(record: {
    key: string;
    projectId: string;
    name: string;
    label: string;
    auto: boolean;
    savedAt: string;
    doc: ProjectDocument;
  }): Promise<void>;
  list(projectId: string): Promise<
    Array<{
      key: string;
      projectId: string;
      name: string;
      label: string;
      auto: boolean;
      savedAt: string;
      doc: ProjectDocument;
    }>
  >;
  remove(projectId: string, name: string): Promise<void>;
}

/** Test/persistence injection. Null until the lazy default repo resolves;
 * a failed resolution memoizes session-only mode. */
let checkpointRepo: CheckpointRepoLike | null = null;
let checkpointRepoResolved = false;
let checkpointRepoPromise: Promise<CheckpointRepoLike | null> | null = null;

/** Test hook \u2014 inject a repository (e.g. fake-indexeddb backed). Pass null
 * to force session-only behavior. */
export function setMcpCheckpointRepository(repo: CheckpointRepoLike | null): void {
  checkpointRepo = repo;
  checkpointRepoResolved = true;
  checkpointRepoPromise = null;
}

/** Test hook \u2014 the store is module-level by design (per-window session). */
export function resetMcpCheckpoints(): void {
  checkpoints.clear();
  checkpointCounter = 0;
}

async function getCheckpointRepo(): Promise<CheckpointRepoLike | null> {
  if (checkpointRepoResolved) return checkpointRepo;
  checkpointRepoPromise ??= (async () => {
    if (typeof indexedDB === "undefined") {
      checkpointRepo = null;
      checkpointRepoResolved = true;
      return null;
    }
    const { McpCheckpointRepository } = await import("../persistence/McpCheckpointRepository");
    checkpointRepo = new McpCheckpointRepository();
    return checkpointRepo;
  })();
  try {
    return await checkpointRepoPromise;
  } catch {
    checkpointRepo = null;
    checkpointRepoResolved = true;
    return null;
  }
}"""
assert old in s, "interface/state block"
s = s.replace(old, new, 1)

# 2) saveCheckpoint: stamp projectId + persist evictions
old = """function saveCheckpoint(rawName: string | undefined, ctx: McpToolContext, auto: boolean): string {
  const name = checkpointName(rawName, auto);
  const doc = ctx.getDoc();
  const active = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  checkpoints.delete(name); // re-save moves the entry to the LRU tail
  checkpoints.set(name, {
    doc: structuredClone(doc),
    stepsAtSave: ctx.undoStackLength(),
    summary: `${doc.tracks.length} tracks \u00b7 active pattern "${active?.name ?? "none"}" \u00b7 ${doc.scenes.length} scenes`,
    auto,
  });
  while (checkpoints.size > CHECKPOINT_LIMIT) {
    const oldest = checkpoints.keys().next().value;
    if (oldest == null) break;
    checkpoints.delete(oldest);
  }
  return name;
}"""
new = """function checkpointProjectId(ctx: McpToolContext): string {
  const doc = ctx.getDoc();
  return doc.id !== "" ? doc.id : `unnamed:${doc.name}`;
}

function saveCheckpoint(rawName: string | undefined, ctx: McpToolContext, auto: boolean): string {
  const name = checkpointName(rawName, auto);
  const doc = ctx.getDoc();
  const projectId = checkpointProjectId(ctx);
  const active = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  checkpoints.delete(name); // re-save moves the entry to the LRU tail
  checkpoints.set(name, {
    doc: structuredClone(doc),
    projectId,
    stepsAtSave: ctx.undoStackLength(),
    summary: `${doc.tracks.length} tracks \u00b7 active pattern "${active?.name ?? "none"}" \u00b7 ${doc.scenes.length} scenes`,
    auto,
  });
  while (checkpoints.size > CHECKPOINT_LIMIT) {
    const oldest = checkpoints.keys().next().value;
    if (oldest == null) break;
    const evicted = checkpoints.get(oldest);
    checkpoints.delete(oldest);
    if (evicted)
      void getCheckpointRepo()
        .then((repo) => repo?.remove(evicted.projectId, oldest))
        .catch(() => {});
  }
  return name;
}"""
assert old in s, "saveCheckpoint"
s = s.replace(old, new, 1)

# 3) executeCheckpointTool: hydrate first + persist save/delete
old = """function executeCheckpointTool(ctx: McpToolContext, record: Record<string, unknown>): McpToolResult {
  const op = String(record.op ?? "list");"""
new = """async function executeCheckpointTool(ctx: McpToolContext, record: Record<string, unknown>): Promise<McpToolResult> {
  const projectId = checkpointProjectId(ctx);
  await hydrateCheckpoints(ctx, projectId);
  const repo = await getCheckpointRepo();
  const op = String(record.op ?? "list");"""
assert old in s, "executor head"
s = s.replace(old, new, 1)

actual_save = (
    '  if (op === "save") {
'
    '    const saved = saveCheckpoint(name === "" ? undefined : name, ctx, false);
'
    '    return {
'
    '      text: `checkpoint "${saved}" saved (${checkpoints.get(saved)?.summary}) — restore anytime, session-scoped, ${checkpoints.size}/${CHECKPOINT_LIMIT} used`,
'
    '      mutated: false,
'
    '    };
'
    '  }'
)
new_save = (
    '  if (op === "save") {
'
    '    const saved = saveCheckpoint(name === "" ? undefined : name, ctx, false);
'
    '    const entry = checkpoints.get(saved)!;
'
    '    let durable = "session only";
'
    '    if (repo != null) {
'
    '      try {
'
    '        await repo.put({
'
    '          key: `${entry.projectId}::${saved}`,
'
    '          projectId: entry.projectId,
'
    '          name: saved,
'
    '          label: entry.summary,
'
    '          auto: entry.auto,
'
    '          savedAt: new Date().toISOString(),
'
    '          doc: entry.doc,
'
    '        });
'
    '        durable = "persisted";
'
    '      } catch {
'
    '        durable = "session only (persistence unavailable)";
'
    '      }
'
    '    }
'
    '    return {
'
    '      text: `checkpoint "${saved}" saved (${entry.summary}) — ${durable}, ${checkpoints.size}/${CHECKPOINT_LIMIT} in memory`,
'
    '      mutated: false,
'
    '    };
'
    '  }'
)
assert actual_save in s, "save branch"
s = s.replace(actual_save, new_save, 1)

actual_delete = (
    '  if (op === "delete") {
'
    '    checkpoints.delete(name);
'
    '    return { text: `checkpoint "${name}" deleted (${checkpoints.size} left)`, mutated: false };
'
    '  }'
)
new_delete = (
    '  if (op === "delete") {
'
    '    checkpoints.delete(name);
'
    '    if (repo != null) void repo.remove(projectId, name).catch(() => {});
'
    '    return { text: `checkpoint "${name}" deleted (${checkpoints.size} left)`, mutated: false };
'
    '  }'
)
assert actual_delete in s, "delete branch"
s = s.replace(actual_delete, new_delete, 1)

assert old in s, "save branch"
s = s.replace(old, new, 1)

old = """  if (op === "delete") {
    checkpoints.delete(name);
    return { text: `checkpoint \"${name}\" deleted (${checkpoints.size} left)`, mutated: false };
  }"""
new = """  if (op === "delete") {
    checkpoints.delete(name);
    if (repo != null) void repo.remove(projectId, name).catch(() => {});
    return { text: `checkpoint \"${name}\" deleted (${checkpoints.size} left)`, mutated: false };
  }"""
assert old in s, "delete branch"
s = s.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("C7 v2 patch applied (bounded)")
