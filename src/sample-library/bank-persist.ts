/**
 * Bank + durable-store persistence with rollback — one contract for every
 * "decode a buffer, make it playable, persist it" path.
 *
 * The sample bank is an in-memory playable cache; the user-sample repository
 * is the durable store. Adding to the bank BEFORE the (slower) IndexedDB write
 * is what makes a freshly decoded sample immediately playable, but it means a
 * persistence failure — a full quota is the realistic one for a large sample
 * import — leaves a ghost buffer: playable now, silently gone after the next
 * reload, with no user-sample row to explain it. Rolling the bank entry back
 * keeps the two stores in agreement, matching `importAudioFile`.
 *
 * A buffer that already existed before the call (a re-import, or a preview
 * that already auditioned this id) is NEVER removed: the failure path only
 * undoes what this call added.
 */

/** The subset of `SampleBank` this helper needs (kept structural so sinks fit). */
export interface RollbackBank {
  get(id: string): AudioBuffer | undefined;
  add(id: string, buffer: AudioBuffer): void;
  remove(id: string): void;
}

const pendingByBank = new WeakMap<RollbackBank, Map<string, Promise<void>>>();

/**
 * Add `buffer` to `bank` under `id` and run `persist`. If `persist` rejects,
 * the bank entry is rolled back (only when this call created it) and the
 * error is re-thrown for the caller to surface.
 */
export async function persistBankBuffer(
  bank: RollbackBank,
  id: string,
  buffer: AudioBuffer,
  persist: () => Promise<void>,
): Promise<void> {
  let pending = pendingByBank.get(bank);
  if (!pending) {
    pending = new Map();
    pendingByBank.set(bank, pending);
  }
  const previous = pending.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  pending.set(id, tail);

  let previousBuffer: AudioBuffer | undefined;
  let installed = false;
  try {
    await previous;
    previousBuffer = bank.get(id);
    bank.add(id, buffer);
    installed = true;
    await persist();
  } catch (error) {
    // The id can be re-imported while persistence is in flight. Serialize
    // same-id writes and restore the exact prior buffer, but only if this
    // operation still owns the bank entry.
    if (installed && bank.get(id) === buffer) {
      if (previousBuffer) bank.add(id, previousBuffer);
      else bank.remove(id);
    }
    throw error;
  } finally {
    release();
    if (pending.get(id) === tail) pending.delete(id);
  }
}
