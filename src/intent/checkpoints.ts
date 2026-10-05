import { McpCheckpointRepository } from "../persistence/McpCheckpointRepository";
import type { ProjectDocument } from "../project-model/types";

/**
 * INTENT-BAR CHECKPOINTS (signal-flow audit re-run 2026-10).
 *
 * The MCP layer keeps agent checkpoints in a session map inside tools.ts with
 * a best-effort write-through into the shared `qvester-mcp-checkpoints` IDB
 * database. The in-app Intent Bar needed the same durability for its
 * destructive-intent safety net (auto-checkpoint before removeTrack /
 * deleteClip / scene-remove) WITHOUT importing the lazy MCP surface into the
 * App chunk — so this module talks to the same REPOSITORY and the same key
 * convention (`${projectId}::${name}`), and MCP's hydrateCheckpoints picks
 * UI-saved checkpoints up on its next list/restore call. Cross-surface
 * restore works through the database; same-surface restore works through the
 * session map.
 *
 * Best-effort policy: IDB failure never blocks the destructive action — the
 * session map alone still serves same-session restore.
 */

const SESSION_LIMIT = 8; // mirrors CHECKPOINT_LIMIT in src/mcp/tools.ts

export interface IntentCheckpoint {
  name: string;
  projectId: string;
  summary: string;
  savedAt: string;
  doc: ProjectDocument;
}

const session = new Map<string, IntentCheckpoint>();

const repo = new McpCheckpointRepository();

function checkpointSummary(doc: ProjectDocument): string {
  const active = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
  return `${doc.tracks.length} tracks · active pattern "${active?.name ?? "none"}" · ${doc.scenes.length} scenes`;
}

/** Save a checkpoint for the project; resolves to its name (never rejects). */
export async function saveIntentCheckpoint(name: string, doc: ProjectDocument): Promise<string> {
  const projectId = doc.id;
  const entry: IntentCheckpoint = {
    name,
    projectId,
    summary: checkpointSummary(doc),
    savedAt: new Date().toISOString(),
    doc: structuredClone(doc),
  };
  session.delete(name); // re-save moves the entry to the LRU tail
  session.set(name, entry);
  while (session.size > SESSION_LIMIT) {
    const oldest = session.keys().next().value;
    if (oldest == null) break;
    session.delete(oldest);
  }
  try {
    await repo.put({
      key: `${projectId}::${name}`,
      projectId,
      name,
      label: entry.summary,
      auto: true,
      savedAt: entry.savedAt,
      doc: entry.doc,
    });
  } catch {
    /* session-only checkpoint — the map still serves restore */
  }
  return name;
}

/** Restore a checkpoint by name, or the newest saved one when unnamed. */
export async function restoreIntentCheckpoint(
  projectId: string,
  name?: string,
): Promise<{ name: string; summary: string; doc: ProjectDocument } | null> {
  const candidates = new Map<string, { name: string; summary: string; savedAt: string; doc: ProjectDocument }>();
  for (const entry of session.values()) {
    if (entry.projectId === projectId) candidates.set(entry.name, entry);
  }
  try {
    for (const record of await repo.list(projectId)) {
      const existing = candidates.get(record.name);
      // The database can hold newer versions (another surface re-saved) and
      // the session map can hold entries the database never saw (offline) —
      // the newer record wins per name.
      if (!existing || existing.savedAt < record.savedAt) {
        candidates.set(record.name, {
          name: record.name,
          summary: record.label,
          savedAt: record.savedAt,
          doc: record.doc,
        });
      }
    }
  } catch {
    /* database unavailable — the session map alone serves restore */
  }
  const pick = name
    ? (candidates.get(name) ?? null)
    : ([...candidates.values()].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0] ?? null);
  return pick ? { name: pick.name, summary: pick.summary, doc: pick.doc } : null;
}

/** Names visible for the project (session map + durable records). */
export async function listIntentCheckpoints(projectId: string): Promise<string[]> {
  const names = new Set<string>();
  for (const [name, entry] of session) if (entry.projectId === projectId) names.add(name);
  try {
    for (const record of await repo.list(projectId)) names.add(record.name);
  } catch {
    /* session-only */
  }
  return [...names];
}
