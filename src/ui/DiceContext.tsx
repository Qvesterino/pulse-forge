import { createContext, useContext, useMemo, useRef, useState, useCallback } from "react";
import type { DrumPad, MusicalKey, NoteEvent, ProjectDocument } from "../project-model/types";
import { getActivePattern, getDrumTrack } from "../project-model/types";
import { generateLocalResultFromOptions } from "../intent/pipeline";
import { refreshPatternOutputHash } from "../intent/quality";
import { buildAssistPatch } from "../assist/pipeline";
import { buildMelodicPhrase } from "../ai/melodicDice";
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
  pickDiceFx,
  applyDiceFxForRoll,
  type DiceSession,
  type DiceLocks,
  type DiceMode,
  type DiceFxCard,
} from "../intent/dice";
import { nextSeed } from "../shared/dice";
import { forkRandom } from "../shared/rng";
import { normalizeIntent } from "../intent/normalize";
import {
  buildFavoritesPack,
  MELODIC_NOTES_CAP,
  recordFavoriteLedgerEntry,
  roleForTrack,
  type FavoriteLedgerEntry,
} from "../intent/favorites";
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
  /** MELODIC target: scale-aware phrase for the instrument track. */
  melodicNotes: NoteEvent[] | null;
  melodicTrackId: string | null;
  /** DICE FX is committed with FULL drum rolls; the ghost preview is dry. */
  fxCard: DiceFxCard | null;
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
  /** Download the favorites ledger as a training pack (local feedback loop). */
  exportFavoritesPack: () => void;
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
  /** Dice target: drums (existing generator) or a melodic phrase for the
   * instrument track (scale-aware walk, seeded by the same session seed). */
  target: "drums" | "melodic";
  setTarget: (target: "drums" | "melodic") => void;
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

  const [target, setTarget] = useState<"drums" | "melodic">("drums");

  const preview = useMemo<DicePreview>(() => {
    const seed = diceCurrentSeed(session);
    const fxCard = target === "drums" && session.mode === "full" ? pickDiceFx(seed, session.locks) : null;
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
        melodicNotes: null,
        melodicTrackId: null,
        fxCard,
      };
    }

    if (target === "melodic") {
      // MELODIC target: scale-aware phrase for the instrument track — a walk
      // over the project scale seeded by the same session seed, so preview
      // and apply agree. Deterministic per (seed, intent, doc).
      const instTrack = doc.tracks.find((t) => t.kind === "instrument");
      const pattern = doc.patterns.find((p) => p.id === doc.activePatternId);
      if (!instTrack || !pattern) {
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
          melodicNotes: null,
          melodicTrackId: null,
          fxCard,
        };
      }
      const phrase = buildMelodicPhrase(doc, {
        seed,
        lengthSteps: Math.min(jittered.length, pattern.stepCount),
        density: 0.3 + session.intent.density * 0.5,
        energy: session.intent.energy,
        key: (doc.key ?? "A Natural Minor") as MusicalKey,
      });
      return {
        mode: session.mode,
        seed,
        fullPattern: null,
        varyPatch: null,
        hitCount: phrase.notes.length,
        beforeHits,
        score: null,
        swing: null,
        kitAssignments: null,
        kitName: null,
        melodicNotes: phrase.notes,
        melodicTrackId: instTrack.id,
        fxCard,
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
          melodicNotes: null,
          melodicTrackId: null,
          fxCard,
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
          melodicNotes: null,
          melodicTrackId: null,
          fxCard,
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
        melodicNotes: null,
        melodicTrackId: null,
        fxCard,
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
        melodicNotes: null,
        melodicTrackId: null,
        fxCard,
      };
    }
  }, [session, doc, active, target]);

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

  const toggleFav = useCallback(
    (index: number) => {
      setSession((prev) => {
        const next = toggleFavorite(prev, index);
        // T2 v2 feedback loop: ★-ing a PREVIEWED roll records it in the local
        // favorites ledger (intent + drum content). The pack is exportable from
        // the tray and folds into the next symbolic-prior retraining
        // (`npm run prior:favorites`). Dedupe + cap live in the ledger module;
        // recording inside the updater is safe — a StrictMode double-invoke
        // collapses via the seed+grooveId dedupe.
        if (index === prev.cursor && next.favorites.has(index) && !prev.favorites.has(index)) {
          const pattern = previewRef.current?.fullPattern?.proposal?.pattern ?? null;
          const drumTrack = doc.tracks.find((track) => track.kind === "drum");
          const generation = pattern?.generation;
          if (pattern && drumTrack && drumTrack.kind === "drum" && generation) {
            // Melodic parts (C1): per instrument track, role via the same
            // name/positional heuristic the generator uses. Notes capped —
            // localStorage is a finite quota.
            const instrumentTracks = doc.tracks.filter((track) => track.kind === "instrument");
            const melodic: FavoriteLedgerEntry["melodic"] = [];
            let noteCount = 0;
            for (const [trackIndex, track] of instrumentTracks.entries()) {
              if (track.kind !== "instrument") continue;
              const notes = pattern.notes?.[track.id] ?? [];
              if (notes.length === 0 || noteCount >= MELODIC_NOTES_CAP) continue;
              const role = roleForTrack(track.name, trackIndex);
              if (!role) continue;
              const capped = notes.slice(0, MELODIC_NOTES_CAP - noteCount).map((note) => ({
                pitch: note.pitch,
                start: note.start,
                duration: note.duration,
                velocity: note.velocity,
              }));
              noteCount += capped.length;
              melodic.push({ role, trackName: track.name, notes: capped });
            }
            const entry: FavoriteLedgerEntry = {
              savedAt: Date.now(),
              seed: prev.seedChain[index] ?? "",
              genre: String(generation.genre ?? prev.intent.genre),
              grooveId: String(generation.grooveId ?? ""),
              energy: prev.intent.energy,
              density: prev.intent.density,
              complexity: prev.intent.complexity,
              variation: prev.intent.variation,
              padIds: drumTrack.pads.map((pad) => pad.id),
              padNames: drumTrack.pads.map((pad) => pad.name),
              rows: JSON.parse(JSON.stringify(pattern.rows)),
              // v2 fields — full reconstruction fidelity for C1/C2 retraining
              length: generation.stepCount,
              style: generation.style ?? null,
              ghostWeight: generation.ghostWeight,
              microWeight: generation.microWeight,
              velocityVariation: generation.velocityVariation,
              temperature: generation.temperature,
              key: doc.key ?? prev.intent.key ?? null,
              melodic,
            };
            recordFavoriteLedgerEntry(entry);
          }
        }
        return next;
      });
    },
    [doc],
  );

  const exportFavoritesPack = useCallback(() => {
    try {
      const pack = buildFavoritesPack();
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pulse-forge-favorites-${new Date(pack.exportedAt).toISOString().slice(0, 10)}.json`;
      anchor.click();
      // Optional-call guard: jsdom/test environments may not implement revoke.
      URL.revokeObjectURL?.(url);
    } catch {
      /* download blocked — favorites stay in the local ledger */
    }
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
      if (target === "melodic") {
        // MELODIC apply: write the seeded phrase into the active pattern for
        // the instrument track — one undo, same notes as the preview.
        const instTrack = currentDoc.tracks.find((t) => t.kind === "instrument");
        const pattern = currentDoc.patterns.find((p) => p.id === currentDoc.activePatternId);
        if (!instTrack || !pattern) return;
        const phrase = buildMelodicPhrase(currentDoc, {
          seed,
          lengthSteps: Math.min(jittered.length, pattern.stepCount),
          density: 0.3 + session.intent.density * 0.5,
          energy: session.intent.energy,
          key: (currentDoc.key ?? "A Natural Minor") as MusicalKey,
        });
        const nextDoc: ProjectDocument = {
          ...currentDoc,
          patterns: currentDoc.patterns.map((p) =>
            p.id === currentDoc.activePatternId
              ? { ...p, notes: { ...(p.notes ?? {}), [instTrack.id]: phrase.notes } }
              : p,
          ),
        };
        services.store.execute(snapshot("diceMelodic", `Dice MELODIC ${seed}`, currentDoc, nextDoc));
        return;
      }
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
        const generated = generatePatternCommand(currentDoc, opts).execute(currentDoc);
        const drumTrackId = currentDoc.tracks.find((track) => track.kind === "drum")?.id;
        const withDiceFx = applyDiceFxForRoll(generated, seed, session.locks, drumTrackId);
        services.store.execute(snapshot("diceFull", `Dice FULL ${seed}`, currentDoc, withDiceFx));
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
      let nextDoc: ProjectDocument = {
        ...currentDoc,
        tracks: nextTracks,
        patterns: [...currentDoc.patterns, lockedPattern],
        scenes: [
          ...currentDoc.scenes,
          { id: uid("scene"), name: lockedPattern.name, patternId: lockedPattern.id, intensity: 0.7 },
        ],
        activePatternId: lockedPattern.id,
      };
      const drumTrackId = nextDoc.tracks.find((track) => track.kind === "drum")?.id;
      nextDoc = applyDiceFxForRoll(nextDoc, seed, session.locks, drumTrackId);
      services.store.execute(snapshot("diceFullLocked", `Dice FULL ${seed}`, currentDoc, nextDoc));
    },
    [session, target],
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
      exportFavoritesPack,
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
      target,
      setTarget,
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
      exportFavoritesPack,
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
      target,
    ],
  );

  return <DiceContext.Provider value={value}>{children}</DiceContext.Provider>;
}
