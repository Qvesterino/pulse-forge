import { openDb, STORE_PRODUCER_MEMORY_EVENTS, tx } from "./db";
import {
  PRODUCER_MEMORY_EVENT_MAX_CHARS,
  PRODUCER_MEMORY_SCHEMA_VERSION,
  createProducerMemoryEventId,
  isValidProducerMemoryPack,
  sanitizeProducerMemoryEvent,
  type ProducerMemoryEvent,
  type ProducerMemoryPackV1,
} from "../intent/producer-memory-core";

function eventSizeIsBounded(event: ProducerMemoryEvent): boolean {
  try {
    return JSON.stringify(event).length <= PRODUCER_MEMORY_EVENT_MAX_CHARS;
  } catch {
    return false;
  }
}

function newestFirst(events: readonly ProducerMemoryEvent[]): ProducerMemoryEvent[] {
  return [...events].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Preserve learning evidence even when high-volume workflow events accumulate. */
function retainEvents(events: readonly ProducerMemoryEvent[]): ProducerMemoryEvent[] {
  const newest = newestFirst(events);
  const forgottenIds = new Set(newest.flatMap((event) => (event.type === "forget" ? event.forgottenEventIds : [])));
  const visible = newest.filter((event) => event.type === "forget" || !forgottenIds.has(event.id));
  const retained = [
    ...visible.filter((event) => event.type === "intent-correction").slice(0, 128),
    ...visible.filter((event) => event.type === "pairwise-choice" || event.type === "settled-edit").slice(0, 304),
    ...visible
      .filter((event) => event.type === "apply" || event.type === "undo" || event.type === "dismiss")
      .slice(0, 32),
    ...visible.filter((event) => event.type === "forget").slice(0, 48),
  ];
  // Every supported event type is assigned a quota above. Do not refill a
  // category's unused space with older excess records from another category.
  return newestFirst(retained);
}

function sanitizeRows(rows: unknown): ProducerMemoryEvent[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(sanitizeProducerMemoryEvent)
    .filter((event): event is ProducerMemoryEvent => event !== null && eventSizeIsBounded(event));
}

async function pruneToCap(): Promise<void> {
  const db = await openDb();
  const rows = await tx<unknown[]>(db, STORE_PRODUCER_MEMORY_EVENTS, "readonly", (store) => store.getAll());
  const events = sanitizeRows(rows);
  const retainedIds = new Set(retainEvents(events).map((event) => event.id));
  const staleIds = new Set(events.filter((event) => !retainedIds.has(event.id)).map((event) => event.id));
  if (staleIds.size === 0) return;
  await tx(db, STORE_PRODUCER_MEMORY_EVENTS, "readwrite", (store) => {
    for (const id of staleIds) store.delete(id);
  });
}

/** Append one validated event and keep the local history bounded. Never throws. */
export async function appendProducerMemoryEvent(value: unknown): Promise<boolean> {
  const event = sanitizeProducerMemoryEvent(value);
  if (!event || !eventSizeIsBounded(event)) return false;
  try {
    const db = await openDb();
    await tx(db, STORE_PRODUCER_MEMORY_EVENTS, "readwrite", (store) => store.put(event));
    await pruneToCap();
    return true;
  } catch {
    return false;
  }
}

/** Read valid events newest first. Corrupt/unknown records are ignored. */
export async function tryListProducerMemoryEvents(): Promise<ProducerMemoryEvent[] | null> {
  try {
    const db = await openDb();
    const rows = await tx<unknown[]>(db, STORE_PRODUCER_MEMORY_EVENTS, "readonly", (store) => store.getAll());
    return retainEvents(sanitizeRows(rows));
  } catch {
    return null;
  }
}

/** Read valid events newest first; unavailable storage safely appears empty to UI callers. */
export async function listProducerMemoryEvents(): Promise<ProducerMemoryEvent[]> {
  return (await tryListProducerMemoryEvents()) ?? [];
}

/** Local explicit export pack. It contains normalized events, never raw prompt/audio. */
export async function exportProducerMemory(exportedAt = Date.now()): Promise<ProducerMemoryPackV1> {
  return {
    schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
    exportedAt: Number.isFinite(exportedAt) && exportedAt >= 0 ? exportedAt : Date.now(),
    events: (await listProducerMemoryEvents()).reverse(),
  };
}

/** Merge a validated export pack into local memory, dedupe by event id, then cap. */
export async function importProducerMemory(value: unknown): Promise<boolean> {
  if (!isValidProducerMemoryPack(value)) return false;
  const events = value.events
    .map(sanitizeProducerMemoryEvent)
    .filter((event): event is ProducerMemoryEvent => event !== null && eventSizeIsBounded(event));
  if (events.length !== value.events.length) return false;
  try {
    const db = await openDb();
    await tx(db, STORE_PRODUCER_MEMORY_EVENTS, "readwrite", (store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const existing = sanitizeRows(request.result);
        const forgottenIds = new Set([
          ...existing.flatMap((event) => (event.type === "forget" ? event.forgottenEventIds : [])),
          ...events.flatMap((event) => (event.type === "forget" ? event.forgottenEventIds : [])),
        ]);
        for (const id of forgottenIds) store.delete(id);
        for (const event of events) {
          if (event.type === "forget" || !forgottenIds.has(event.id)) store.put(event);
        }
      };
    });
    await pruneToCap();
    return true;
  } catch {
    return false;
  }
}

/** Forget selected events and keep a bounded tombstone for future imports. */
export async function forgetProducerMemoryEvents(ids: readonly string[]): Promise<boolean> {
  if (ids.length > 128 || ids.some((id) => !/^[a-zA-Z0-9._:-]{1,128}$/.test(id))) return false;
  if (ids.length === 0) return true;
  try {
    const db = await openDb();
    await tx(db, STORE_PRODUCER_MEMORY_EVENTS, "readwrite", (store) => {
      const uniqueIds = [...new Set(ids)];
      for (const id of uniqueIds) store.delete(id);
      const event = sanitizeProducerMemoryEvent({
        schemaVersion: PRODUCER_MEMORY_SCHEMA_VERSION,
        id: createProducerMemoryEventId(),
        createdAt: Date.now(),
        sessionId: null,
        lineageId: null,
        type: "forget",
        forgottenEventIds: uniqueIds,
      });
      if (event?.type === "forget") store.put(event);
    });
    await pruneToCap();
    return true;
  } catch {
    return false;
  }
}

/** Full Producer DNA reset. It does not touch projects or the separate personal model. */
export async function clearProducerMemory(): Promise<boolean> {
  try {
    const db = await openDb();
    await tx(db, STORE_PRODUCER_MEMORY_EVENTS, "readwrite", (store) => store.clear());
    return true;
  } catch {
    return false;
  }
}
