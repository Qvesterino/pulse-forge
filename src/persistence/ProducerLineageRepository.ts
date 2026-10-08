import { openDb, STORE_PRODUCER_LINEAGE, tx } from "./db";
import { forgetProducerMemoryEvents, listProducerMemoryEvents } from "./ProducerMemoryRepository";
import {
  createProducerLineageNode,
  PRODUCER_LINEAGE_NODE_CAP,
  PRODUCER_LINEAGE_NODE_MAX_CHARS,
  sanitizeProducerLineageNode,
  type ProducerLineageDraft,
  type ProducerLineageNodeV1,
  type ProducerLineagePackV1,
} from "../intent/producer-lineage-core";

function bounded(node: ProducerLineageNodeV1): boolean {
  try {
    return JSON.stringify(node).length <= PRODUCER_LINEAGE_NODE_MAX_CHARS;
  } catch {
    return false;
  }
}

function newestFirst(nodes: readonly ProducerLineageNodeV1[]): ProducerLineageNodeV1[] {
  return [...nodes].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function sanitizeRows(rows: unknown): ProducerLineageNodeV1[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(sanitizeProducerLineageNode)
    .filter((node): node is ProducerLineageNodeV1 => node !== null && bounded(node));
}

async function pruneToCap(): Promise<void> {
  const db = await openDb();
  const rows = await tx<unknown[]>(db, STORE_PRODUCER_LINEAGE, "readonly", (store) => store.getAll());
  const nodes = newestFirst(sanitizeRows(rows));
  const retainedIds = new Set(nodes.slice(0, PRODUCER_LINEAGE_NODE_CAP).map((node) => node.id));
  const staleIds = nodes.filter((node) => !retainedIds.has(node.id)).map((node) => node.id);
  if (staleIds.length === 0) return;
  await tx(db, STORE_PRODUCER_LINEAGE, "readwrite", (store) => {
    for (const id of staleIds) store.delete(id);
  });
}

/** Read the most recent resumable candidates; only compact musical snapshots are returned. */
export async function listProducerLineageNodes(projectKey?: string): Promise<ProducerLineageNodeV1[]> {
  try {
    const db = await openDb();
    const rows = await tx<unknown[]>(db, STORE_PRODUCER_LINEAGE, "readonly", (store) => store.getAll());
    const forgottenIds = new Set(
      (await listProducerMemoryEvents()).flatMap((event) => (event.type === "forget" ? event.forgottenEventIds : [])),
    );
    return newestFirst(sanitizeRows(rows))
      .filter((node) => !forgottenIds.has(node.id))
      .filter((node) => projectKey === undefined || node.projectKey === projectKey)
      .slice(0, PRODUCER_LINEAGE_NODE_CAP);
  } catch {
    return [];
  }
}

/** Save one generated take and inherit its root hash from the selected parent branch. */
export async function saveProducerLineageDraft(draft: ProducerLineageDraft): Promise<ProducerLineageNodeV1 | null> {
  try {
    const existing = await listProducerLineageNodes(draft.projectKey);
    const parent = draft.parentContentHash
      ? existing.find((node) => node.contentHash === draft.parentContentHash)
      : undefined;
    const node = createProducerLineageNode(
      draft,
      parent?.rootContentHash ?? draft.parentContentHash ?? draft.contentHash,
    );
    if (!node || !bounded(node)) return null;
    const db = await openDb();
    await tx(db, STORE_PRODUCER_LINEAGE, "readwrite", (store) => store.put(node));
    await pruneToCap();
    return node;
  } catch {
    return null;
  }
}

/** Remove a node and its descendants so the remaining branch graph has no dangling child links. */
export async function forgetProducerLineageBranch(nodeId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(nodeId)) return false;
  try {
    const nodes = await listProducerLineageNodes();
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return false;
    const doomedIds = new Set([target.id]);
    const doomedHashes = new Set([target.contentHash]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (
          node.projectKey === target.projectKey &&
          node.parentContentHash !== null &&
          doomedHashes.has(node.parentContentHash) &&
          !doomedIds.has(node.id)
        ) {
          doomedIds.add(node.id);
          doomedHashes.add(node.contentHash);
          changed = true;
        }
      }
    }
    if (!(await forgetProducerMemoryEvents([...doomedIds]))) return false;
    const db = await openDb();
    await tx(db, STORE_PRODUCER_LINEAGE, "readwrite", (store) => {
      for (const id of doomedIds) store.delete(id);
    });
    return true;
  } catch {
    return false;
  }
}

export async function exportProducerLineage(exportedAt = Date.now()): Promise<ProducerLineagePackV1> {
  return {
    schemaVersion: 1,
    exportedAt: Number.isFinite(exportedAt) && exportedAt >= 0 ? exportedAt : Date.now(),
    nodes: (await listProducerLineageNodes()).reverse(),
  };
}

/** Merge an already-validated portable branch pack by node id. */
export async function importProducerLineage(nodes: readonly unknown[]): Promise<boolean> {
  if (nodes.length > PRODUCER_LINEAGE_NODE_CAP) return false;
  const sanitized = nodes
    .map(sanitizeProducerLineageNode)
    .filter((node): node is ProducerLineageNodeV1 => node !== null && bounded(node));
  if (sanitized.length !== nodes.length) return false;
  try {
    const forgottenIds = new Set(
      (await listProducerMemoryEvents()).flatMap((event) => (event.type === "forget" ? event.forgottenEventIds : [])),
    );
    const db = await openDb();
    await tx(db, STORE_PRODUCER_LINEAGE, "readwrite", (store) => {
      for (const node of sanitized) {
        if (!forgottenIds.has(node.id)) store.put(node);
      }
    });
    await pruneToCap();
    return true;
  } catch {
    return false;
  }
}

export async function clearProducerLineage(): Promise<boolean> {
  try {
    const db = await openDb();
    await tx(db, STORE_PRODUCER_LINEAGE, "readwrite", (store) => store.clear());
    return true;
  } catch {
    return false;
  }
}
