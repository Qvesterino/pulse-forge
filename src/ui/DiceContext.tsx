import { createContext, useContext, useMemo, useState, useCallback, useEffect } from "react";
import type { ProjectDocument } from "../project-model/types";
import { getActivePattern, getDrumTrack } from "../project-model/types";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import { buildAssistPatch } from "../assist/pipeline";
import { generatePatternCommand, assistVary, snapshot } from "../commands/commands";
import { generatePattern } from "../ai/generator";
import type { Services } from "../services";
import { uid } from "../shared/ids";
import {
  createDiceSession,
  rollSession,
  jumpSession,
  toggleLock,
  toggleFavorite,
  setDiceMode,
  setDiceJitter,
  setDiceIntent,
  applyDiceLocks,
  diceCurrentSeed,
  jitteredIntentForSeed,
  type DiceSession,
  type DiceLocks,
  type DiceMode,
} from "../intent/dice";
import { nextSeed } from "../shared/dice";
import { normalizeIntent } from "../intent/normalize";
import type { GenerateOptions } from "../ai/types";
import { GENRES } from "../ai/types";

export interface DicePreview {
  mode: DiceMode;
  seed: string;
  fullPattern: ReturnType<typeof generateLocalResultFromOptions> | null;
  varyPatch: ReturnType<typeof buildAssistPatch> | null;
  hitCount: number;
  beforeHits: number;
  score: number | null;
}

interface DiceContextValue {
  session: DiceSession;
  preview: DicePreview;
  rollFull: () => void;
  rollVary: () => void;
  jump: (index: number) => void;
  apply: (services: Services, doc: ProjectDocument) => void;
  toggleLockKey: (key: keyof DiceLocks) => void;
  toggleFav: (index: number) => void;
  setMode: (mode: DiceMode) => void;
  setJitter: (v: number) => void;
  setGenre: (genre: GenerateOptions["genre"]) => void;
  setStyle: (style: string | null) => void;
  setSeed: (seed: string) => void;
  setLength: (len: number) => void;
  setEnergy: (v: number) => void;
  setDensity: (v: number) => void;
  setComplexity: (v: number) => void;
  setVariation: (v: number) => void;
  setMood: (m: string | null) => void;
  canApply: boolean;
}

const DiceContext = createContext<DiceContextValue | null>(null);

export function useDice(): DiceContextValue {
  const ctx = useContext(DiceContext);
  if (!ctx) throw new Error("DiceContext not initialized — wrap with DiceProvider");
  return ctx;
}

export function DiceProvider({ doc, children }: { doc: ProjectDocument; children: React.ReactNode }) {
  const [session, setSession] = useState<DiceSession>(() => {
    const initIntent = normalizeIntent({
      genre: "house" as const,
      seed: nextSeed(String(Date.now()), "dice-init"),
      length: 16,
    });
    return createDiceSession(initIntent, initIntent.seed);
  });

  function diceScore(
    pat:
      | {
          generation?: {
            quality?: {
              anchorCoverage?: number;
              styleDistance?: number;
              styleAccepted?: boolean;
              syncopation?: number;
              melodicMotifRepetition?: number;
            };
          };
        }
      | null
      | undefined,
  ): number | null {
    const q = pat?.generation?.quality;
    if (!q) return null;
    const anchor = typeof q.anchorCoverage === "number" ? q.anchorCoverage : 0.5;
    const styleAcc = q.styleAccepted ? 1 : Math.max(0, 1 - (q.styleDistance ?? 0.5));
    const sync = typeof q.syncopation === "number" ? Math.min(1, q.syncopation / 8) : 0.5;
    const motif = typeof q.melodicMotifRepetition === "number" ? q.melodicMotifRepetition : 0.5;
    const raw = anchor * 40 + styleAcc * 30 + sync * 15 + motif * 15;
    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  const preview = useMemo<DicePreview>(() => {
    const seed = diceCurrentSeed(session);
    const jittered = jitteredIntentForSeed(session.intent, seed, session.jitter);
    const beforeHits = (() => {
      try {
        const pat = getActivePattern(doc);
        return Object.values(pat.rows).reduce((s, r) => s + r.filter((v) => v > 0).length, 0);
      } catch {
        return 0;
      }
    })();

    if (session.mode === "vary") {
      try {
        const pat = getActivePattern(doc);
        const pads = getDrumTrack(doc).pads;
        const patch = buildAssistPatch(pat, pads, {
          operation: "vary",
          seed,
          amount: 0.6,
          bars: 4,
          target: "hats",
          style: "house",
        });
        const hits = Object.values(patch.rows).reduce((s, r) => s + r.filter((v) => v > 0).length, 0);
        return { mode: "vary", seed, fullPattern: null, varyPatch: patch, hitCount: hits, beforeHits, score: null };
      } catch {
        return { mode: "vary", seed, fullPattern: null, varyPatch: null, hitCount: 0, beforeHits, score: null };
      }
    }

    // Full mode — use subSeed locks for preview=apply parity when locks active
    try {
      const opts: GenerateOptions = {
        genre: jittered.genre,
        style: jittered.style ?? undefined,
        seed: jittered.seed,
        stepCount: jittered.length,
        ghostWeight: jittered.controls.ghostWeight,
        microWeight: jittered.controls.microWeight,
        velocityVariation: jittered.controls.velocityVariation,
        temperature: jittered.controls.temperature,
        replaceMode: "new",
        drumTrackId: doc.tracks.find((t) => t.kind === "drum")?.id,
      };
      const hasLocks = Object.values(session.locks).some(Boolean);
      let result = generateLocalResultFromOptions(doc, opts, "preview");
      if (hasLocks && result.proposal?.pattern) {
        const prev = (() => {
          try {
            return getActivePattern(doc);
          } catch {
            return null;
          }
        })();
        if (prev) {
          // Regenerate with subSeed locks for true parity
          const lockedPattern = generatePattern(doc, opts, { ...session.locks, prevPattern: prev });
          result = {
            ...result,
            proposal: { ...result.proposal, pattern: lockedPattern },
          } as typeof result;
        } else {
          const locked = applyDiceLocks(null, result.proposal.pattern, session.locks, doc);
          result.proposal.pattern = locked;
        }
      } else if (result.proposal?.pattern && hasLocks) {
        const prev = (() => {
          try {
            return getActivePattern(doc);
          } catch {
            return null;
          }
        })();
        const locked = applyDiceLocks(prev, result.proposal.pattern, session.locks, doc);
        result.proposal.pattern = locked;
      }
      const pat = result.proposal?.pattern;
      const hits = pat ? Object.values(pat.rows).reduce((s, r) => s + r.filter((v) => v > 0).length, 0) : 0;
      const score = diceScore(pat);
      return { mode: "full", seed, fullPattern: result, varyPatch: null, hitCount: hits, beforeHits, score };
    } catch {
      return { mode: "full", seed, fullPattern: null, varyPatch: null, hitCount: 0, beforeHits, score: null };
    }
  }, [session, doc]);

  const rollFull = useCallback(() => {
    setSession((prev) => {
      const asFull = prev.mode === "full" ? prev : { ...prev, mode: "full" as const };
      return rollSession(asFull);
    });
  }, []);

  const rollVary = useCallback(() => {
    setSession((prev) => {
      const asVary = prev.mode === "vary" ? prev : { ...prev, mode: "vary" as const };
      return rollSession(asVary);
    });
  }, []);

  const jump = useCallback((index: number) => {
    setSession((prev) => jumpSession(prev, index));
  }, []);

  const toggleLockKey = useCallback((key: keyof DiceLocks) => {
    setSession((prev) => toggleLock(prev, key));
  }, []);

  const toggleFav = useCallback((index: number) => {
    setSession((prev) => toggleFavorite(prev, index));
  }, []);

  const setMode = useCallback((mode: DiceMode) => {
    setSession((prev) => setDiceMode(prev, mode));
  }, []);

  const setJitter = useCallback((v: number) => {
    setSession((prev) => setDiceJitter(prev, v));
  }, []);

  const setGenre = useCallback((genre: GenerateOptions["genre"]) => {
    if (!GENRES.includes(genre as (typeof GENRES)[number])) return;
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, genre } as unknown as DiceSession["intent"]));
  }, []);

  const setStyle = useCallback((style: string | null) => {
    setSession((prev) =>
      setDiceIntent(prev, { ...prev.intent, style: style ?? null } as unknown as DiceSession["intent"]),
    );
  }, []);

  const setSeed = useCallback((seed: string) => {
    setSession((prev) => {
      const intent = normalizeIntent({ ...prev.intent, seed: seed.slice(0, 16) });
      // Replace current seed in chain
      const idx = prev.cursor;
      const chain = [...prev.seedChain];
      chain[idx] = seed.slice(0, 16);
      return { ...prev, intent, seedChain: chain };
    });
  }, []);

  const setLength = useCallback((len: number) => {
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, length: len } as unknown as DiceSession["intent"]));
  }, []);

  const setEnergy = useCallback((v: number) => {
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, energy: v } as unknown as DiceSession["intent"]));
  }, []);
  const setDensity = useCallback((v: number) => {
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, density: v } as unknown as DiceSession["intent"]));
  }, []);
  const setComplexity = useCallback((v: number) => {
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, complexity: v } as unknown as DiceSession["intent"]));
  }, []);
  const setVariation = useCallback((v: number) => {
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, variation: v } as unknown as DiceSession["intent"]));
  }, []);
  const setMood = useCallback((m: string | null) => {
    setSession((prev) => setDiceIntent(prev, { ...prev.intent, mood: m } as unknown as DiceSession["intent"]));
  }, []);

  const apply = useCallback(
    (services: Services, currentDoc: ProjectDocument) => {
      const seed = diceCurrentSeed(session);
      const jittered = jitteredIntentForSeed(session.intent, seed, session.jitter);
      if (session.mode === "vary") {
        try {
          const pat = getActivePattern(currentDoc);
          services.store.execute(assistVary(currentDoc, pat.id, seed, 0.6));
        } catch {}
        return;
      }
      const opts: GenerateOptions = {
        genre: jittered.genre,
        style: jittered.style ?? undefined,
        seed: jittered.seed,
        stepCount: jittered.length,
        ghostWeight: jittered.controls.ghostWeight,
        microWeight: jittered.controls.microWeight,
        velocityVariation: jittered.controls.velocityVariation,
        temperature: jittered.controls.temperature,
        replaceMode: "new",
        drumTrackId: currentDoc.tracks.find((t) => t.kind === "drum")?.id,
      };
      const hasLocks = Object.values(session.locks).some(Boolean);
      if (!hasLocks) {
        services.store.execute(generatePatternCommand(currentDoc, opts));
        return;
      }
      const prev = (() => {
        try {
          return getActivePattern(currentDoc);
        } catch {
          return null;
        }
      })();
      // SubSeed locked generation (preview = apply)
      let lockedPattern: ReturnType<typeof generatePattern> | null = null;
      try {
        lockedPattern = generatePattern(currentDoc, opts, { ...session.locks, prevPattern: prev });
      } catch {
        const fallback = generateLocalResultFromOptions(currentDoc, opts, "apply");
        lockedPattern = fallback.proposal?.pattern
          ? applyDiceLocks(prev, fallback.proposal.pattern, session.locks, currentDoc)
          : null;
      }
      if (!lockedPattern) {
        services.store.execute(generatePatternCommand(currentDoc, opts));
        return;
      }
      const nextDoc: ProjectDocument = {
        ...currentDoc,
        patterns: [...currentDoc.patterns, lockedPattern],
        scenes: [
          ...currentDoc.scenes,
          { id: uid("scene"), name: lockedPattern.name, patternId: lockedPattern.id, intensity: 0.7 },
        ],
        activePatternId: lockedPattern.id,
      };
      services.store.execute(snapshot("diceFullLocked", `Dice FULL ${seed}`, currentDoc, nextDoc));
    },
    [session],
  );

  // Hotkeys: D = roll full, Shift+D = roll vary, arrows = history
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;
      if (e.defaultPrevented) return;
      // Don't hijack when modifiers except shift for Shift+D
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === "d" && !e.shiftKey) {
        e.preventDefault();
        rollFull();
      } else if (e.key.toLowerCase() === "d" && e.shiftKey) {
        e.preventDefault();
        rollVary();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSession((prev) => jumpSession(prev, Math.max(0, prev.cursor - 1)));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSession((prev) => jumpSession(prev, Math.min(prev.seedChain.length - 1, prev.cursor + 1)));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [rollFull, rollVary]);

  const value: DiceContextValue = {
    session,
    preview,
    rollFull,
    rollVary,
    jump,
    apply,
    toggleLockKey,
    toggleFav,
    setMode,
    setJitter,
    setGenre,
    setStyle,
    setSeed,
    setLength,
    setEnergy,
    setDensity,
    setComplexity,
    setVariation,
    setMood,
    canApply: true,
  };

  return <DiceContext.Provider value={value}>{children}</DiceContext.Provider>;
}
