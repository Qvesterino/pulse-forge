import { createContext, useContext, useMemo, useRef, useState, useCallback } from "react";
import type { DrumPad, ProjectDocument } from "../project-model/types";
import { getActivePattern, getDrumTrack } from "../project-model/types";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import { refreshPatternOutputHash } from "../intent/quality";
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
  setDiceKit,
  applyDiceLocks,
  diceCurrentSeed,
  jitteredIntentForSeed,
  type DiceSession,
  type DiceLocks,
  type DiceMode,
} from "../intent/dice";
import { nextSeed } from "../shared/dice";
import { forkRandom } from "../shared/rng";
import { normalizeIntent } from "../intent/normalize";
import type { GenerateOptions } from "../ai/types";
import { GENRES } from "../ai/types";
import { resolveGrooveForGeneration } from "../ai/generator";
import { resolveKitAssignments } from "../sample-library/kit-pools";
import { kitPresetById, resolveKitPreset } from "../project-model/kit-presets";

export interface DicePreview {
  mode: DiceMode;
  seed: string;
  fullPattern: ReturnType<typeof generateLocalResultFromOptions> | null;
  varyPatch: ReturnType<typeof buildAssistPatch> | null;
  hitCount: number;
  beforeHits: number;
  score: number | null;
  swing: number | null;
  kitAssignments: Map<string, Partial<DrumPad>> | null;
  kitName: string | null;
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
  setKitId: (kitId: string | null) => void;
  canApply: boolean;
}

const DiceContext = createContext<DiceContextValue | null>(null);

export function useDice(): DiceContextValue {
  const ctx = useContext(DiceContext);
  if (!ctx) throw new Error("DiceContext not initialized — wrap with DiceProvider");
  return ctx;
}

export function DiceProvider({
  doc,
  active = false,
  children,
}: {
  doc: ProjectDocument;
  /** Whether the dice tray is visible. The provider is always mounted, so an
   * always-on preview would rerun the full generation pipeline (~0.5 s sync)
   * on EVERY doc edit — edits felt frozen with the panel closed. */
  active?: boolean;
  children: React.ReactNode;
}) {
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

    if (!active) {
      // Tray unmounted — nothing displays the preview, so skip the pipeline.
      // Rolls cannot fire while inactive either: their hotkeys live in the
      // tray. Opening the panel recomputes the real preview.
      return {
        mode: session.mode,
        seed,
        fullPattern: null,
        varyPatch: null,
        hitCount: 0,
        beforeHits,
        score: null,
        swing: null,
        kitAssignments: null,
        kitName: null,
      };
    }

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
        return {
          mode: "vary",
          seed,
          fullPattern: null,
          varyPatch: patch,
          hitCount: hits,
          beforeHits,
          score: null,
          swing: null,
          kitAssignments: null,
          kitName: null,
        };
      } catch {
        return {
          mode: "vary",
          seed,
          fullPattern: null,
          varyPatch: null,
          hitCount: 0,
          beforeHits,
          score: null,
          swing: null,
          kitAssignments: null,
          kitName: null,
        };
      }
    }

    // Full mode — use subSeed locks for preview=apply parity when locks active + swing/kit jitter
    try {
      let opts: GenerateOptions = {
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
      // Swing jitter — derive groove first, then jitter
      let swing: number | null = null;
      let kitAssignments: Map<string, Partial<DrumPad>> | null = null;
      try {
        const groove = resolveGrooveForGeneration(doc, opts);
        if (session.jitter > 0.15) {
          const r = forkRandom(seed, "dice.swing");
          const jitteredSwing = Math.max(0, Math.min(1, groove.swing + (r() - 0.5) * 0.4 * session.jitter));
          if (Math.abs(jitteredSwing - groove.swing) > 0.01) {
            swing = Math.round(jitteredSwing * 100) / 100;
            opts = { ...opts, _diceSwing: swing } as GenerateOptions & { _diceSwing?: number };
          } else {
            swing = groove.swing;
          }
        } else {
          swing = groove.swing;
        }
      } catch {
        swing = null;
      }
      // Kit assignments (full kit variability — preset + per-pad)
      let kitName: string | null = null;
      try {
        const pads = getDrumTrack(doc).pads;
        const kitMap = resolveKitAssignments(pads, seed, session.locks, session.jitter, {
          genre: jittered.genre,
          kitId: session.kitId,
          mood: jittered.mood,
        });
        kitAssignments = kitMap.size > 0 ? (kitMap as Map<string, Partial<DrumPad>>) : null;
        if (kitAssignments && kitAssignments.size === 0) kitAssignments = null;
        if (kitAssignments) {
          if (session.kitId) kitName = kitPresetById(session.kitId)?.name ?? session.kitId;
          else kitName = resolveKitPreset(`${seed}|${jittered.genre}`, jittered.genre).name;
        }
      } catch {
        kitAssignments = null;
        kitName = null;
      }
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
          // The locked content differs from the generated rows the recipe
          // hashed — refresh outputContentHash so provenance describes the
          // content actually previewed/applied.
          const hashed = refreshPatternOutputHash(doc, lockedPattern);
          result = {
            ...result,
            proposal: { ...result.proposal, pattern: hashed },
          } as typeof result;
        } else {
          const locked = refreshPatternOutputHash(
            doc,
            applyDiceLocks(null, result.proposal.pattern, session.locks, doc),
          );
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
        const locked = refreshPatternOutputHash(doc, applyDiceLocks(prev, result.proposal.pattern, session.locks, doc));
        result.proposal.pattern = locked;
      }
      const pat = result.proposal?.pattern;
      const hits = pat ? Object.values(pat.rows).reduce((s, r) => s + r.filter((v) => v > 0).length, 0) : 0;
      const score = diceScore(pat);
      return {
        mode: "full",
        seed,
        fullPattern: result,
        varyPatch: null,
        hitCount: hits,
        beforeHits,
        score,
        swing,
        kitAssignments,
        kitName,
      };
    } catch {
      return {
        mode: "full",
        seed,
        fullPattern: null,
        varyPatch: null,
        hitCount: 0,
        beforeHits,
        score: null,
        swing: null,
        kitAssignments: null,
        kitName: null,
      };
    }
  }, [session, doc, active]);

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
  const setKitId = useCallback((kitId: string | null) => {
    setSession((prev) => setDiceKit(prev, kitId));
  }, []);

  // Latest rendered preview, readable from apply() without re-memoizing the
  // whole context value on every preview change. Apply commits THIS result —
  // the content the user saw — instead of regenerating.
  const previewRef = useRef<DicePreview | null>(null);
  previewRef.current = preview;

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
      // Kit assignments (full kit — preset + per-pad)
      let kitAssignments: Map<string, Partial<DrumPad>> | null = null;
      try {
        const pads = getDrumTrack(currentDoc).pads;
        kitAssignments = resolveKitAssignments(pads, seed, session.locks, session.jitter, {
          genre: jittered.genre,
          kitId: session.kitId,
          mood: jittered.mood,
        });
        if (kitAssignments.size === 0) kitAssignments = null;
      } catch {
        kitAssignments = null;
      }
      // Preview/apply identity: the preview memo already ran the generation
      // (with locks + swing jitter) for THIS session state. Commit that exact
      // result; regenerate only if no preview exists (tray never opened).
      const previewedResult = previewRef.current?.fullPattern ?? null;
      const previewedPattern = previewedResult?.proposal?.pattern ?? null;
      if (!previewedResult || !previewedPattern) {
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
        services.store.execute(generatePatternCommand(currentDoc, opts));
        return;
      }
      const lockedPattern = previewedPattern;
      // Apply kit assignments to drum track (single undo with pattern) — full kit patch
      let nextTracks = currentDoc.tracks;
      if (kitAssignments && kitAssignments.size > 0) {
        nextTracks = currentDoc.tracks.map((t) => {
          if (t.kind !== "drum") return t;
          const pads = t.pads.map((p) => {
            const patch = kitAssignments!.get(p.id);
            if (patch) {
              return {
                ...p,
                assetId: patch.assetId !== undefined ? patch.assetId : p.assetId,
                synth: patch.synth !== undefined ? patch.synth : p.synth,
                gain: patch.gain !== undefined ? patch.gain! : p.gain,
                pan: patch.pan !== undefined ? patch.pan! : p.pan,
                chokeGroup: patch.chokeGroup !== undefined ? patch.chokeGroup : p.chokeGroup,
                sliceStart: patch.assetId !== undefined ? undefined : p.sliceStart,
                sliceEnd: patch.assetId !== undefined ? undefined : p.sliceEnd,
                sliceFadeIn: patch.assetId !== undefined ? undefined : p.sliceFadeIn,
                sliceFadeOut: patch.assetId !== undefined ? undefined : p.sliceFadeOut,
                sliceReverse: patch.assetId !== undefined ? undefined : p.sliceReverse,
              };
            }
            return p;
          });
          return { ...t, pads };
        });
      }
      const nextDoc: ProjectDocument = {
        ...currentDoc,
        tracks: nextTracks,
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

  // Hotkeys (D = roll full, Shift+D = roll vary, arrows = history) live in
  // DiceTray, not here: the provider is always mounted, so a global listener
  // would fire the dice on the pad key "D"/"A"/"S" while the user is playing
  // the drum rack or nudging notes in the piano roll. The visible tray owns
  // its keyboard surface.

  // Memoized: a fresh value object per render would re-render every consumer
  // of the always-mounted provider on each parent pass.
  const value: DiceContextValue = useMemo(
    () => ({
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
      setKitId,
      canApply: true,
    }),
    [
      session,
      preview,
      apply,
      rollFull,
      rollVary,
      jump,
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
      setKitId,
    ],
  );

  return <DiceContext.Provider value={value}>{children}</DiceContext.Provider>;
}
