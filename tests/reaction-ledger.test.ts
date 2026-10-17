import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  REACTION_KEEP_WINDOW_MS,
  REACTION_MASH_GUARD_MS,
  ReactionLedger,
  hashReactionState,
  isReactionLedgerEnabled,
  sanitizeAction,
  sanitizeReactionEntry,
  sanitizeReactionPack,
  sanitizeTrackIds,
  setActiveReactionLedger,
  setReactionLedgerEnabled,
  type ReactionStorage,
} from "../src/intent/reaction-ledger";

/**
 * REACTION LEDGER (F1) — the gates the plan states, one spec each.
 *
 * The privacy specs are the load-bearing ones. The ledger's whole premise is
 * that it learns from what the human DOES with a proposal, never from what they
 * SAID. "We were careful at the call site" is not a privacy boundary, so the
 * boundary is asserted here against a module that has no way to express prose.
 */

function makeLedger(startAt = 1_000_000) {
  let now = startAt;
  const rows: Array<unknown> = [];
  const storage: ReactionStorage = {
    load: async () => rows as never,
    save: async (entries) => {
      rows.length = 0;
      rows.push(...entries);
    },
    clear: async () => {
      rows.length = 0;
    },
  };
  let idCounter = 0;
  const ledger = new ReactionLedger({
    now: () => now,
    storage,
    newId: () => `rx-${++idCounter}`,
  });
  return {
    ledger,
    storage,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

const PROPOSAL = {
  routeKind: "paramIntent",
  action: { verb: "adjust", subject: "effect", relative: true },
  trackIds: ["track-1", "track-2"],
  beforeHash: hashReactionState({ gain: 0.5 }),
  afterHash: hashReactionState({ gain: 0.6 }),
  undoDepth: 3,
};

describe("reaction ledger — proposals and their outcomes", () => {
  it("registers a proposal as pending and exposes it without leaking prose", () => {
    const { ledger } = makeLedger();
    const entry = ledger.register(PROPOSAL);
    expect(entry).not.toBeNull();
    expect(entry!.outcome).toBe("pending");
    expect(ledger.pendingCount()).toBe(1);
    expect(ledger.summary().pending).toBe(1);
  });

  it("carries the generation identity and the applied candidate (the F2 join)", () => {
    const { ledger } = makeLedger();
    const entry = ledger.register({ ...PROPOSAL, generationId: "gen-1234567890", candidateIndex: 2 });
    expect(entry).toMatchObject({ generationId: "gen-1234567890", candidateIndex: 2 });
    // And it survives the storage round trip (sanitizeReactionEntry).
    const restored = sanitizeReactionEntry(JSON.parse(JSON.stringify(entry)));
    expect(restored).toMatchObject({ generationId: "gen-1234567890", candidateIndex: 2 });
  });

  it("drops a malformed generation identity instead of half-recording it", () => {
    const { ledger } = makeLedger();
    // A prose string is not a generation id, and a negative index is not an
    // index: both degrade to ABSENT — the reaction is still a usable row.
    const entry = ledger.register({
      ...PROPOSAL,
      generationId: "the user asked for a dark trap beat",
      candidateIndex: -1,
    });
    expect(entry).not.toBeNull();
    expect(entry!.generationId).toBeUndefined();
    expect(entry!.candidateIndex).toBeUndefined();
  });

  it("KEEP — the keep window closes with no reaction", () => {
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_KEEP_WINDOW_MS);
    const summary = ledger.summary();
    expect(summary.pending).toBe(0);
    expect(summary.kept).toBe(1);
    expect(summary.keepRate).toBe(1);
  });

  it("KEEP (early) — the transport moving on settles a proposal before the window", () => {
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_MASH_GUARD_MS + 1_000);
    ledger.noteTransportProgress();
    expect(ledger.summary().kept).toBe(1);
    expect(ledger.pendingCount()).toBe(0);
  });

  it("UNDO — reverting THIS proposal is a rejection", () => {
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_MASH_GUARD_MS + 1_000);
    const undone = ledger.noteUndo(3);
    expect(undone?.outcome).toBe("undone");
    expect(ledger.summary().undone).toBe(1);
    expect(ledger.summary().keepRate).toBe(0);
  });

  it("UNDO — reverting a DIFFERENT history entry is not a reaction to this one", () => {
    // The depth is what identifies the proposal. A user edit of some earlier
    // command must not be read as "they rejected my suggestion".
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_MASH_GUARD_MS + 1_000);
    expect(ledger.noteUndo(0)).toBeNull();
    expect(ledger.noteUndo(7)).toBeNull();
    expect(ledger.summary().undone).toBe(0);
    expect(ledger.summary().pending).toBe(1);
  });

  it("MASH GUARD — an instant undo is a keypress, not a verdict", () => {
    const { ledger } = makeLedger();
    ledger.register(PROPOSAL);
    // 1 s after apply: discarded entirely.
    expect(ledger.noteUndo(3)).toBeNull();
    // CRITICAL: it must NOT age into "kept" afterwards. Recording it either way
    // teaches the wrong lesson — "undo fast" must never become "keep".
    ledger.sweep();
    expect(ledger.summary().kept).toBe(0);
    expect(ledger.summary().undone).toBe(0);
    expect(ledger.summary().pending).toBe(0);
  });

  it("TWEAK — a human edit on the same tracks after keep is a correction pair", () => {
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_KEEP_WINDOW_MS);
    ledger.sweep();
    const tweaked = ledger.noteUserEdit(["track-2"]);
    expect(tweaked?.outcome).toBe("tweaked");
    expect(tweaked?.beforeHash).toBe(PROPOSAL.beforeHash);
    expect(tweaked?.afterHash).toBe(PROPOSAL.afterHash);
    expect(ledger.summary().tweaked).toBe(1);
  });

  it("TWEAK — an edit on unrelated tracks is not a reaction", () => {
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_KEEP_WINDOW_MS);
    ledger.sweep();
    expect(ledger.noteUserEdit(["track-99"])).toBeNull();
    expect(ledger.summary().tweaked).toBe(0);
    expect(ledger.summary().kept).toBe(1);
  });

  it("TWEAK — an edit while the proposal is still PENDING does not rewrite history", () => {
    // Otherwise a tweak during the keep window would pre-empt the verdict the
    // human has not given yet.
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_MASH_GUARD_MS + 500);
    expect(ledger.noteUserEdit(["track-1"])).toBeNull();
    expect(ledger.summary().pending).toBe(1);
  });

  it("an unknown route kind is dropped rather than half-recorded", () => {
    const { ledger } = makeLedger();
    // Nothing to learn from an unlabelled proposal, and storage is capped.
    expect(ledger.register({ ...PROPOSAL, routeKind: "Zo života" })).toBeNull();
    expect(ledger.pendingCount()).toBe(0);
  });
});

describe("reaction ledger — privacy boundary", () => {
  it("a prompt string cannot survive as an action", () => {
    // The caller's raw text is not even representable: the sanitiser maps a
    // CLOSED vocabulary, and anything unknown becomes `adjust:unknown`.
    const action = sanitizeAction({
      verb: "make the vocal sound more intimate",
      subject: "lower the lead vocal reverb mix slightly",
      relative: "please make it warmer and less harsh",
    });
    expect(action).toBe("adjust:unknown:abs");
    expect(action).not.toMatch(/vocal|reverb|intimate/i);
  });

  it("an entry survives a full round trip with no free text anywhere", () => {
    const { ledger, advance, storage } = makeLedger();
    ledger.register({
      ...PROPOSAL,
      action: { verb: "please sing softer", subject: "the mix", relative: "warmer" },
      trackIds: ["track-1", "../../etc/passwd", "track-2"],
    });
    advance(REACTION_KEEP_WINDOW_MS);
    ledger.sweep();
    const pack = ledger.exportPack();
    const serialised = JSON.stringify(pack);
    expect(serialised).not.toMatch(/sing|softer|warm/i);
    expect(serialised).not.toMatch(/passwd/);
    // The path-shaped id is dropped; the well-formed ones survive.
    expect(storage).toBeDefined();
    expect(pack.entries[0].trackIds).toEqual(["track-1", "track-2"]);
  });

  it("track NAMES never reach the ledger — only ids", () => {
    const ids = sanitizeTrackIds(["track-1", "Lead Vocal (final)", "a".repeat(200)]);
    expect(ids).toEqual(["track-1"]);
  });

  it("reload is defensive: junk in the store yields junk out, never a throw", () => {
    expect(sanitizeReactionEntry(null)).toBeNull();
    expect(sanitizeReactionEntry({ id: "rx-1" })).toBeNull();
    expect(sanitizeReactionEntry({ id: "rx-1", createdAt: Number.NaN })).toBeNull();
    const survivor = sanitizeReactionEntry({
      id: "rx-1",
      createdAt: 5,
      routeKind: "!!!",
      action: "totally free text",
      trackIds: ["track-1", 42, null],
      beforeHash: "zzz",
      outcome: "nonsense",
    });
    expect(survivor).not.toBeNull();
    expect(survivor!.routeKind).toBe("unknown");
    expect(survivor!.outcome).toBe("pending");
    expect(survivor!.beforeHash).toBe("");
    expect(survivor!.trackIds).toEqual(["track-1"]);

    expect(sanitizeReactionPack({ entries: "not an array" })).toBeNull();
    const pack = sanitizeReactionPack({ entries: [{ id: "rx-1", createdAt: 1 }, "junk"] });
    expect(pack!.entries).toHaveLength(1);
  });

  it("a corrupt store degrades to an empty ledger instead of breaking the app", async () => {
    const ledger = new ReactionLedger({
      now: () => 1,
      storage: {
        load: async () => {
          throw new Error("IndexedDB unavailable");
        },
        save: async () => {},
        clear: async () => {},
      },
    });
    await expect(ledger.hydrate()).resolves.toBeUndefined();
    expect(ledger.entries()).toEqual([]);
  });
});

describe("reaction ledger — export + cap", () => {
  it("export carries the version, the entries and nothing else", () => {
    const { ledger, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_MASH_GUARD_MS + 1);
    ledger.noteUndo(3);
    const pack = ledger.exportPack();
    expect(pack.schemaVersion).toBe(1);
    expect(pack.entries).toHaveLength(1);
    expect(pack.entries[0].outcome).toBe("undone");
  });

  it("history is bounded — a busy session cannot grow it without limit", () => {
    let now = 1_000_000;
    const ledger = new ReactionLedger({
      now: () => now,
      storage: null,
      cap: 4,
      newId: (() => {
        let n = 0;
        return () => `rx-${++n}`;
      })(),
    });
    for (let i = 0; i < 12; i++) {
      ledger.register({ ...PROPOSAL, undoDepth: i });
      now += REACTION_MASH_GUARD_MS + 1;
      ledger.noteUndo(i);
    }
    expect(ledger.entries()).toHaveLength(4);
  });

  it("clear() empties pending AND history, and wipes the store", async () => {
    const { ledger, storage, advance } = makeLedger();
    ledger.register(PROPOSAL);
    advance(REACTION_KEEP_WINDOW_MS);
    ledger.sweep();
    expect(ledger.entries().length).toBeGreaterThan(0);
    await ledger.clear();
    expect(ledger.entries()).toEqual([]);
    expect(await storage.load()).toEqual([]);
  });
});

describe("reaction ledger — opt-in", () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveReactionLedger(null);
  });
  afterEach(() => {
    localStorage.clear();
    setActiveReactionLedger(null);
  });

  it("defaults ON, and the kill switch is total", () => {
    expect(isReactionLedgerEnabled()).toBe(true);
    setReactionLedgerEnabled(false);
    expect(isReactionLedgerEnabled()).toBe(false);
    setReactionLedgerEnabled(true);
    expect(isReactionLedgerEnabled()).toBe(true);
  });
});
