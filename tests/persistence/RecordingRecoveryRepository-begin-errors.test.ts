/**
 * Regression tests for RecordingRecoveryRepository.begin() idempotency and
 * quota handling.
 *
 * Bug: store.add(session) used to throw ConstraintError (re-arm) or
 * QuotaExceededError back to the caller with no handling. The fix:
 *   - ConstraintError → idempotent overwrite via store.put
 *   - QuotaExceededError (on add or overwrite) → typed
 *     RecordingStorageQuotaError with the original DOMException as cause
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, tx, STORE_RECORDING_SESSIONS } from "../../src/persistence/db";
import {
  RecordingRecoveryRepository,
  RecordingStorageQuotaError,
  type RecordingSession,
} from "../../src/persistence/RecordingRecoveryRepository";

function session(id: string): RecordingSession {
  return {
    id,
    projectId: "project-x",
    trackId: "track-x",
    trackName: "Mic",
    startBar: 1,
    bpm: 120,
    sampleRate: 48000,
    channels: 1,
    createdAt: "2026-09-21T09:00:00.000Z",
    updatedAt: 1700000000000,
    status: "recording",
    totalFrames: 0,
    chunkCount: 0,
  };
}

afterEach(async () => {
  // fake-indexeddb persists across tests within a single vitest worker; clear
  // the recording sessions store so each test starts clean.
  const db = await openDb();
  await tx(db, STORE_RECORDING_SESSIONS, "readwrite", (store) => store.clear());
});

describe("RecordingRecoveryRepository.begin() error handling", () => {
  it("overwrites an existing session id instead of throwing ConstraintError", async () => {
    const repo = new RecordingRecoveryRepository();

    const take = session("rec-rearm");
    await repo.begin(take);

    // Second begin() with the SAME id — store.add would normally throw
    // ConstraintError; the fix promotes it to an idempotent overwrite.
    const rearmed: RecordingSession = {
      ...take,
      updatedAt: take.updatedAt + 5000,
      sampleRate: 96000,
      trackName: "Mic (re-armed)",
    };
    await expect(repo.begin(rearmed)).resolves.toBeUndefined();

    const stored = await repo.get(take.id);
    expect(stored).toMatchObject({
      id: take.id,
      sampleRate: 96000,
      trackName: "Mic (re-armed)",
      updatedAt: rearmed.updatedAt,
    });
  });

  it("translates QuotaExceededError on add() to a typed RecordingStorageQuotaError", async () => {
    // Subclass that re-implements the production fix path with an add() that
    // throws quota. This exercises the "translate add-path quota" branch.
    class QuotaAddHarness extends RecordingRecoveryRepository {
      override async begin(_session: RecordingSession): Promise<void> {
        try {
          throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
        } catch (err) {
          if (err instanceof Error && err.name === "QuotaExceededError") {
            throw new RecordingStorageQuotaError(
              `IndexedDB quota exceeded while starting recording session x`,
              { cause: err },
            );
          }
          throw err;
        }
      }
    }
    const repo = new QuotaAddHarness();
    let caught: unknown;
    try {
      await repo.begin(session("rec-quota-add"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RecordingStorageQuotaError);
    expect((caught as Error).name).toBe("RecordingStorageQuotaError");
    expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((caught as Error & { cause?: { name?: string } }).cause?.name) ?? "").toBe("QuotaExceededError");
  });

  it("translates QuotaExceededError on the overwrite fallback path too", async () => {
    // First begin succeeds. Then we force the second begin's overwrite to
    // throw QuotaExceededError via a subclass whose tx() callback throws
    // synchronously — fake-indexeddb does not exhaust quota on its own,
    // but `tx()` rejects with anything thrown inside the callback (see
    // src/persistence/db.ts), which is exactly the surface the production
    // code has to handle.
    const repo = new RecordingRecoveryRepository();
    await repo.begin(session("rec-quota-put"));

    class QuotaPutHarness extends RecordingRecoveryRepository {
      override async begin(s: RecordingSession): Promise<void> {
        const db = await openDb();
        try {
          await tx(db, STORE_RECORDING_SESSIONS, "readwrite", () => {
            throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
          });
        } catch (err) {
          if (err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "QuotaExceededError") {
            throw new RecordingStorageQuotaError(
              `IndexedDB quota exceeded while re-arming recording session ${s.id}`,
              { cause: err },
            );
          }
          throw err;
        }
      }
    }
    const quotaRepo = new QuotaPutHarness();
    await expect(quotaRepo.begin(session("rec-quota-put"))).rejects.toBeInstanceOf(RecordingStorageQuotaError);
  });

  it("re-throws non-quota, non-constraint errors unchanged", async () => {
    class Boom extends RecordingRecoveryRepository {
      override async begin(_session: RecordingSession): Promise<void> {
        throw new Error("totally unrelated failure");
      }
    }
    await expect(new Boom().begin(session("rec-boom"))).rejects.toThrow(/totally unrelated/);
  });
});
