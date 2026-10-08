import { useEffect, useMemo, useRef, useState } from "react";
import { canonicalizePattern, contentHash } from "../ai/evaluation";
import { extractPatternFeaturesV2 } from "../ai/features/pattern-features-v2";
import type { Pattern, ProjectDocument } from "../project-model/types";
import {
  orderTasteProbeSides,
  suggestBlindProducerDnaPilotPair,
  suggestTasteProbePair,
  tasteProbePairKey,
} from "../intent/taste-probe";
import {
  comparedPairKeys,
  generationsWithoutProducerDnaVote,
  noteGenerationWithoutVote,
  noteProbeDismissed,
  noteProducerDnaVote,
  proactiveProbeState,
} from "../intent/proactive-probe";
import { isPreferenceReasonRankable } from "../intent/personal-ranker";
import { isAudioPreferenceReason, supportsAudioPreferenceReason } from "../intent/audio-personal-ranker";
import { currentProducerMemorySessionId } from "../intent/producer-memory-session";
import { setAutomaticStyleLearningEnabled } from "../intent/style-example-ledger";
import { clearAllProducerMemory } from "../intent/producer-memory-management";
import {
  buildProducerMemoryPack,
  createPreferenceObservation,
  importProducerMemoryPack,
  isPreferenceLearningEnabled,
  PREFERENCE_LEDGER_CHANGED_EVENT,
  preferenceContextForIntent,
  readPreferenceLedger,
  recordProducerMemoryWorkflowEvent,
  recordPreferenceObservation,
  setPreferenceLearningEnabled,
  type PreferenceChoice,
  type PreferenceReason,
} from "../intent/preference-ledger";
import type { GenerationResult, RankedCandidate } from "../intent/types";

interface ProducerDnaCompareProps {
  project: ProjectDocument;
  result: GenerationResult;
  /** Original take for a recursive iteration, compared against its variants. */
  referencePattern?: Pattern | null;
  /** Root lineage identifier used to keep recursive A/B outcomes in one eval group. */
  lineageId?: string | null;
  blindPilotArmed?: boolean;
  blindPilotArmRevision?: number;
  generationRevision?: number;
  onBlindPilotArmedChange?: (armed: boolean) => void;
  /** Hide the ranked bank for the rest of this result after a blind pilot starts. */
  onBlindPilotVisibilityChange?: (hidden: boolean) => void;
  onAudition: (candidate: RankedCandidate) => void;
}

const REASONS: readonly { value: PreferenceReason; label: string }[] = [
  { value: "groove", label: "groove" },
  { value: "drums", label: "bicie" },
  // W4: both are measured since features.v2 (bass note density / root
  // alignment, chord voicing movement / harmonic rhythm).
  { value: "bass", label: "basa" },
  { value: "harmony", label: "harmónia" },
  { value: "melody", label: "melódia" },
  { value: "space", label: "priestor frázy" },
  { value: "energy", label: "energia aranžmánu" },
  { value: "novelty", label: "originalita motívu" },
  { value: "brightness", label: "jas zvuku" },
  { value: "lowEnd", label: "množstvo basov" },
  { value: "dynamics", label: "dynamika" },
  { value: "level", label: "hlasitosť" },
  { value: "timbre", label: "timbre / farba zvuku" },
  { value: "voicing", label: "tonálnosť / harmonickosť" },
  { value: "stereo", label: "stereo obraz" },
];

function explicitComparisonCount(): number {
  return readPreferenceLedger().filter((observation) => observation.source !== "edit").length;
}

function reasonEvidenceCountsFor(contextKey: string): Partial<Record<PreferenceReason, number>> {
  const counts: Partial<Record<PreferenceReason, number>> = {};
  for (const observation of readPreferenceLedger()) {
    if (
      observation.context.key !== contextKey ||
      (observation.choice !== "a" && observation.choice !== "b") ||
      !observation.reason
    ) {
      continue;
    }
    counts[observation.reason] = (counts[observation.reason] ?? 0) + 1;
  }
  return counts;
}

async function downloadPack(): Promise<void> {
  const pack = await buildProducerMemoryPack();
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "kyx-producer-memory-v1.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export function ProducerDnaCompare({
  project,
  result,
  referencePattern = null,
  lineageId = null,
  blindPilotArmed = false,
  blindPilotArmRevision = 0,
  generationRevision = 0,
  onBlindPilotArmedChange,
  onBlindPilotVisibilityChange,
  onAudition,
}: ProducerDnaCompareProps) {
  const candidates = result.bank ?? [];
  const referenceCandidate = useMemo<RankedCandidate | null>(
    () =>
      referencePattern
        ? {
            candidateIndex: -1,
            seed: referencePattern.generation?.seed ?? "iteration-parent",
            source: "template",
            status: "accepted",
            repairs: [],
            score: 0,
            modelScore: null,
            contentHash: contentHash(canonicalizePattern(project, referencePattern)),
            pattern: referencePattern,
          }
        : null,
    [project, referencePattern],
  );
  const comparisonCandidates = referenceCandidate ? [...candidates, referenceCandidate] : candidates;
  const [aIndex, setAIndex] = useState<number | null>(null);
  const [bIndex, setBIndex] = useState<number | null>(null);
  const [reason, setReason] = useState<PreferenceReason | "">("");
  const [blindProbeActive, setBlindProbeActive] = useState(false);
  const [blindPilotActive, setBlindPilotActive] = useState(false);
  const [blindPilotResultHidden, setBlindPilotResultHidden] = useState(false);
  const [blindPilotGlobalSide, setBlindPilotGlobalSide] = useState<"a" | "b" | null>(null);
  const blindPilotArmedRef = useRef(blindPilotArmed);
  blindPilotArmedRef.current = blindPilotArmed;
  const [skippedProbePairs, setSkippedProbePairs] = useState<ReadonlySet<string>>(() => new Set());
  const [learningEnabled, setLearningEnabled] = useState(isPreferenceLearningEnabled);
  const [comparisonCount, setComparisonCount] = useState(explicitComparisonCount);
  const [message, setMessage] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const featureCache = useRef<{
    result: GenerationResult;
    project: ProjectDocument;
    referencePattern: Pattern | null;
    rows: Map<number, Float32Array>;
  } | null>(null);

  const context = useMemo(() => preferenceContextForIntent(result.plan.intent), [result.plan.intent]);
  const blindPilotPair = useMemo(
    () =>
      suggestBlindProducerDnaPilotPair(
        candidates.map((candidate) => ({
          candidate,
          candidateIndex: candidate.candidateIndex,
          contentHash: candidate.contentHash,
          globalScore: candidate.globalScore,
          personalScore: candidate.personalScore,
          globalScoreVersion: candidate.globalScoreVersion,
        })),
      ),
    [candidates],
  );
  const candidateA = comparisonCandidates.find((candidate) => candidate.candidateIndex === aIndex) ?? null;
  const candidateB = comparisonCandidates.find((candidate) => candidate.candidateIndex === bIndex) ?? null;
  const candidateFeatures = (requested: readonly RankedCandidate[]) => {
    const cache =
      featureCache.current?.result === result &&
      featureCache.current.project === project &&
      featureCache.current.referencePattern === referencePattern
        ? featureCache.current
        : { result, project, referencePattern, rows: new Map<number, Float32Array>() };
    const batch = comparisonCandidates.map((candidate) => candidate.pattern);
    for (const candidate of requested) {
      if (cache.rows.has(candidate.candidateIndex)) continue;
      cache.rows.set(
        candidate.candidateIndex,
        // W4: record the v2 contract (bass / harmony / arrangement axes), so
        // a "bass" or "harmony" vote trains a real adapter.
        extractPatternFeaturesV2({
          doc: project,
          pattern: candidate.pattern,
          intent: result.plan.intent,
          options: result.plan.options,
          resolvedBpm: result.plan.resolvedBpm,
          batch,
        }).values,
      );
    }
    featureCache.current = cache;
    return cache.rows;
  };

  useEffect(() => {
    setAIndex(null);
    setBIndex(null);
    setReason("");
    setBlindProbeActive(false);
    setBlindPilotActive(false);
    setBlindPilotGlobalSide(null);
    setBlindPilotResultHidden(blindPilotArmedRef.current);
    onBlindPilotVisibilityChange?.(blindPilotArmedRef.current);
    setSkippedProbePairs(new Set());
    setMessage("");
  }, [result, referencePattern, onBlindPilotVisibilityChange]);

  useEffect(() => {
    const refreshLearningState = () => setLearningEnabled(isPreferenceLearningEnabled());
    window.addEventListener(PREFERENCE_LEDGER_CHANGED_EVENT, refreshLearningState);
    return () => window.removeEventListener(PREFERENCE_LEDGER_CHANGED_EVENT, refreshLearningState);
  }, []);

  /**
   * W3 proactive probe: after N generations in this context WITHOUT an
   * explicit vote, the panel offers ONE controlled question on its own. The
   * counter is a session streak (a reload starts fresh); an explicit vote or a
   * dismissal resets it, so this can never become a nagging loop.
   */
  const armProbe = useRef<(pair: ReturnType<typeof proactiveProbeState>["proposal"]) => void>(() => {});

  useEffect(() => {
    if (!learningEnabled) return;
    if (blindPilotArmed) return;
    if (blindProbeActive || blindPilotResultHidden) return;
    if (referenceCandidate && candidates.length > 0) {
      const child = candidates[0];
      if (!child || child.contentHash === referenceCandidate.contentHash) {
        setMessage("Pôvodný take a najlepšia iterácia majú rovnaký hudobný obsah; niet čo porovnávať.");
        return;
      }
      const pairKey = tasteProbePairKey(referenceCandidate.contentHash, child.contentHash);
      if (comparedPairKeys(readPreferenceLedger(), context.key).has(pairKey)) {
        setMessage("Tento pôvodný take a iterácia už boli porovnané. Môžeš si ručne vybrať inú dvojicu.");
        return;
      }
      let randomByte: number | undefined;
      try {
        randomByte = window.crypto.getRandomValues(new Uint8Array(1))[0];
      } catch {
        const hash = `${referenceCandidate.contentHash}:${child.contentHash}`;
        randomByte =
          Array.from(hash).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0) & 0xff;
      }
      const parentFirst = (randomByte ?? 0) % 2 === 1;
      setAIndex(parentFirst ? referenceCandidate.candidateIndex : child.candidateIndex);
      setBIndex(parentFirst ? child.candidateIndex : referenceCandidate.candidateIndex);
      setReason("");
      setBlindProbeActive(true);
      setMessage(
        "Slepé porovnanie pôvodného take-u a iterácie: strany sú náhodne priradené. Vypočuj obe; nič sa neuloží, kým nepotvrdíš voľbu.",
      );
      return;
    }
    if (candidates.length < 2) return;
    noteGenerationWithoutVote();
    const features = candidateFeatures(candidates);
    const observations = readPreferenceLedger();
    const state = proactiveProbeState({
      candidates: candidates.map((candidate) => ({
        candidate,
        candidateIndex: candidate.candidateIndex,
        contentHash: candidate.contentHash,
        features: features.get(candidate.candidateIndex) ?? [],
        globalScore: candidate.globalScore,
        globalScoreVersion: candidate.globalScoreVersion,
      })),
      generationsWithoutVote: generationsWithoutProducerDnaVote(),
      learningEnabled,
      excludedPairKeys: new Set([...comparedPairKeys(observations, context.key), ...skippedProbePairs]),
      reasonEvidenceCounts: reasonEvidenceCountsFor(context.key),
      preferenceObservations: observations,
      preferenceContext: context,
    });
    if (state.proposal) armProbe.current(state.proposal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    result,
    referenceCandidate,
    referencePattern,
    learningEnabled,
    blindPilotArmed,
    blindProbeActive,
    blindPilotResultHidden,
  ]);

  // Assign the (stateful) A/B sides from a proposed pair.
  useEffect(() => {
    armProbe.current = (pair) => {
      if (!pair) return;
      let randomByte: number | undefined;
      try {
        randomByte = window.crypto.getRandomValues(new Uint8Array(1))[0];
      } catch {
        const hash = `${pair.candidateA.contentHash}:${pair.candidateB.contentHash}`;
        randomByte =
          Array.from(hash).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0) & 0xff;
      }
      const [sideA, sideB] = orderTasteProbeSides(pair, (randomByte ?? 0) % 2 === 1);
      setAIndex(sideA.candidateIndex);
      setBIndex(sideB.candidateIndex);
      setReason(pair.reason);
      setBlindProbeActive(true);
      setMessage("Chcem sa ťa niečo spýtať — nič sa neuloží, kým nepotvrdíš voľbu.");
    };
  }, []);

  const selectA = (index: number) => {
    setBlindProbeActive(false);
    setBlindPilotActive(false);
    setBlindPilotGlobalSide(null);
    setAIndex(index);
    setReason("");
    if (bIndex === index) setBIndex(null);
    setMessage("");
  };
  const selectB = (index: number) => {
    setBlindProbeActive(false);
    setBlindPilotActive(false);
    setBlindPilotGlobalSide(null);
    setBIndex(index);
    setReason("");
    if (aIndex === index) setAIndex(null);
    setMessage("");
  };

  const startBlindPilot = () => {
    if (!learningEnabled || !blindPilotPair) {
      setMessage("Pilot sa nedá spustiť: zapni lokálne učenie a počkaj na odlišné, jednoznačné výbery oboch rankerov.");
      return false;
    }
    const pairKey = tasteProbePairKey(
      blindPilotPair.globalCandidate.contentHash,
      blindPilotPair.personalCandidate.contentHash,
    );
    if (comparedPairKeys(readPreferenceLedger(), context.key).has(pairKey)) {
      setMessage(
        "Tieto dva kandidáty už boli porovnané v tomto kontexte; ďalšie generovanie môže priniesť nový blind pilot.",
      );
      return false;
    }
    let randomByte: number;
    try {
      randomByte = window.crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
    } catch {
      setMessage("Bezpečné náhodné priradenie strán nie je dostupné; pilot sa nespustil a nič sa neuložilo.");
      return false;
    }
    const globalFirst = randomByte % 2 === 0;
    const candidateA = globalFirst ? blindPilotPair.globalCandidate : blindPilotPair.personalCandidate;
    const candidateB = globalFirst ? blindPilotPair.personalCandidate : blindPilotPair.globalCandidate;
    setBlindPilotGlobalSide(globalFirst ? "a" : "b");
    setAIndex(candidateA.candidateIndex);
    setBIndex(candidateB.candidateIndex);
    setReason("");
    setBlindProbeActive(true);
    setBlindPilotActive(true);
    setBlindPilotResultHidden(true);
    onBlindPilotVisibilityChange?.(true);
    setMessage(
      "Opt-in blind pilot: porovnáva sa globálny a osobný výber z rovnakého banku. Strany sú náhodne priradené a ich pôvod zostane skrytý. Odpoveď aj skóre sa uložia len lokálne.",
    );
    return true;
  };

  useEffect(() => {
    if (!blindPilotArmed || generationRevision <= blindPilotArmRevision || blindPilotActive) return;
    const started = startBlindPilot();
    onBlindPilotArmedChange?.(false);
    if (!started) {
      setBlindPilotResultHidden(false);
      onBlindPilotVisibilityChange?.(false);
    }
    // A fresh generation is required after arming; the current visible bank
    // must never be retroactively turned into a blind pilot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blindPilotArmed, blindPilotArmRevision, generationRevision, result, blindPilotActive]);

  const vote = (choice: PreferenceChoice) => {
    if (!candidateA || !candidateB || !learningEnabled) return;
    if (blindPilotActive && !blindPilotGlobalSide) {
      setMessage("Chýba bezpečný záznam priradenia strán; túto pilotnú voľbu neuložím.");
      return;
    }
    if (
      reason &&
      isAudioPreferenceReason(reason) &&
      !supportsAudioPreferenceReason(reason, candidateA.audioFeatures, candidateB.audioFeatures)
    ) {
      setMessage("Táto zvuková vlastnosť nie je dostupná v oboch rendroch, preto sa dôvod nedá bezpečne uložiť.");
      return;
    }
    const features = candidateFeatures([candidateA, candidateB]);
    const observation = createPreferenceObservation(
      context,
      {
        contentHash: candidateA.contentHash,
        features: features.get(candidateA.candidateIndex) ?? [],
        audioFeatures: candidateA.audioFeatures,
        globalScore: candidateA.globalScore,
        globalScoreVersion: candidateA.globalScoreVersion,
        personalScore: candidateA.personalScore,
      },
      {
        contentHash: candidateB.contentHash,
        features: features.get(candidateB.candidateIndex) ?? [],
        audioFeatures: candidateB.audioFeatures,
        globalScore: candidateB.globalScore,
        globalScoreVersion: candidateB.globalScoreVersion,
        personalScore: candidateB.personalScore,
      },
      choice,
      {
        ...(reason && !blindPilotActive ? { reason } : {}),
        ...(blindPilotActive ? { study: "producer-dna-blind-pilot" as const } : {}),
        ...(blindPilotActive && blindPilotGlobalSide
          ? { pilotAssignment: { globalSide: blindPilotGlobalSide, displayedChoice: choice } }
          : {}),
      },
    );
    if (
      !observation ||
      !recordPreferenceObservation(observation, {
        sessionId: currentProducerMemorySessionId(),
        lineageId: lineageId ?? referenceCandidate?.contentHash ?? candidates[0]?.contentHash ?? null,
      })
    ) {
      setMessage("Voľbu sa nepodarilo uložiť lokálne.");
      return;
    }
    // An explicit vote ends the "no feedback" streak — the panel will not
    // proactively ask again until N fresh generations pass.
    noteProducerDnaVote();
    if (blindPilotActive) {
      setComparisonCount(explicitComparisonCount());
      setAIndex(null);
      setBIndex(null);
      setReason("");
      setBlindProbeActive(false);
      setBlindPilotActive(false);
      setBlindPilotGlobalSide(null);
      setMessage(
        "Pilotová voľba uložená iba lokálne. Zdroj A/B zostáva skrytý; report vyhodnotí captured-score lift oproti globálnemu poradiu.",
      );
      return;
    }
    const preferred = choice === "a" ? "A" : "B";
    const hasParent = candidateA.candidateIndex === -1 || candidateB.candidateIndex === -1;
    const parentSide = candidateA.candidateIndex === -1 ? "A" : "B";
    const sourceReveal =
      referenceCandidate && hasParent
        ? choice === "a" || choice === "b"
          ? ` Vybral si ${(choice === "a" ? candidateA : candidateB).candidateIndex === -1 ? "pôvodný take" : "iteráciu"}; pôvodný take bol ${parentSide}.`
          : ` Pôvodný take bol ${parentSide}.`
        : "";
    if (choice === "neither") {
      setMessage(`Uložené ako ‘ani jeden’ — bez učenia smeru.${sourceReveal}`);
    } else if (choice === "both") {
      setMessage(`Uložené ako ‘oba dobré’ — bez učenia smeru.${sourceReveal}`);
    } else if (reason && !isPreferenceReasonRankable(reason)) {
      setMessage(
        `Voľba ${preferred} je uložená, ale tento ranker zatiaľ nemá feature osi pre „${reason}“.${sourceReveal}`,
      );
    } else if (reason) {
      setMessage(
        `Voľba ${preferred} uložená pre „${reason}“; táto os sa použije po aspoň 2 relevantných porovnaniach.${sourceReveal}`,
      );
    } else {
      setMessage(
        `Voľba ${preferred} uložená ako všeobecná preferencia; učenie sa aktivuje po aspoň 2 porovnaniach.${sourceReveal}`,
      );
    }
    setComparisonCount(explicitComparisonCount());
    setAIndex(null);
    setBIndex(null);
    setReason("");
    setBlindProbeActive(false);
  };

  const suggestProbe = () => {
    const features = candidateFeatures(candidates);
    const observations = readPreferenceLedger();
    const previouslyCompared = observations
      .filter((observation) => observation.context.key === context.key)
      .map((observation) => tasteProbePairKey(observation.candidateA.contentHash, observation.candidateB.contentHash));
    const excludedPairKeys = new Set([...skippedProbePairs, ...previouslyCompared]);
    const probe = suggestTasteProbePair(
      candidates.map((candidate) => ({
        candidate,
        candidateIndex: candidate.candidateIndex,
        contentHash: candidate.contentHash,
        features: features.get(candidate.candidateIndex) ?? [],
        globalScore: candidate.globalScore,
        globalScoreVersion: candidate.globalScoreVersion,
      })),
      excludedPairKeys,
      reasonEvidenceCountsFor(context.key),
      observations,
      context,
    );
    if (!probe) {
      setBlindProbeActive(false);
      setAIndex(null);
      setBIndex(null);
      setReason("");
      setMessage(
        "V tomto banku niet nového páru s porovnateľným globálnym skóre a jasným rozdielom v jednej meranej osi; môžeš vybrať A/B ručne.",
      );
      return;
    }
    let randomByte: number | undefined;
    try {
      randomByte = window.crypto.getRandomValues(new Uint8Array(1))[0];
    } catch {
      // Crypto can be unavailable in restricted contexts; keep a stable,
      // content-derived fallback rather than reverting to rank-based sides.
      const hash = `${probe.candidateA.contentHash}:${probe.candidateB.contentHash}`;
      randomByte =
        Array.from(hash).reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0) & 0xff;
    }
    const [sideA, sideB] = orderTasteProbeSides(probe, (randomByte ?? 0) % 2 === 1);
    setAIndex(sideA.candidateIndex);
    setBIndex(sideB.candidateIndex);
    setReason(probe.reason);
    setBlindProbeActive(true);
    const reasonLabel = REASONS.find((item) => item.value === probe.reason)?.label ?? probe.reason;
    setMessage(
      `Strany A/B sú náhodne priradené; poradie a zdroj take-ov sú skryté. Pár sa najviac líši v meranej osi „${reasonLabel}“; globálny výber sa líši o ${Math.round(probe.globalScoreGap * 100)} p. b. Vypočuj obe strany — nič sa neuloží, kým nepotvrdíš voľbu.`,
    );
  };

  const toggleLearning = () => {
    const next = !learningEnabled;
    setPreferenceLearningEnabled(next);
    setAutomaticStyleLearningEnabled(next);
    setLearningEnabled(next);
    if (!next) {
      setAIndex(null);
      setBIndex(null);
      setBlindProbeActive(false);
      setBlindPilotActive(false);
      setBlindPilotGlobalSide(null);
      setBlindPilotResultHidden(false);
      onBlindPilotVisibilityChange?.(false);
    }
    setMessage(next ? "Lokálne Producer DNA učenie zapnuté." : "Všetko lokálne Producer DNA učenie pozastavené.");
  };

  const clear = async () => {
    if (
      !window.confirm(
        "Vymazať lokálne Producer DNA voľby, ★ učenie, ručné úpravy a osobné prior modely? Táto akcia sa nedá vrátiť.",
      )
    )
      return;
    setMemoryBusy(true);
    const allCleared = await clearAllProducerMemory();
    setComparisonCount(0);
    setMessage(
      allCleared
        ? "Lokálna Producer DNA pamäť, úpravy aj osobné prior modely boli vymazané. Projekty zostali nedotknuté."
        : "Vymazanie sa dokončilo len čiastočne; niektorá lokálna databáza alebo pamäť nebola dostupná.",
    );
    setMemoryBusy(false);
  };

  const importPack = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      setMessage("Export pamäte je väčší než povolený limit 16 MB.");
      return;
    }
    setMemoryBusy(true);
    try {
      const raw = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        setMessage("Súbor nie je platný JSON export Producer DNA.");
        return;
      }
      const result = await importProducerMemoryPack(parsed);
      if (!result.eventsImported) {
        setMessage("Export nebol importovaný; jeho verzia, obsah alebo lokálne úložisko nie sú podporované.");
      } else if (!result.rankerLedgerImported) {
        setMessage("Eventy sa importovali, ale ranker ledger sa nepodarilo aktualizovať.");
      } else if (!result.lineageImported) {
        setMessage("Producer DNA eventy sa importovali; niektoré uložené vetvy sa nepodarilo obnoviť.");
      } else if (!result.favoritesImported || !result.styleExamplesImported) {
        setMessage("A/B pamäť sa importovala; obľúbené patterny alebo štýlové príklady sa nepodarilo obnoviť celé.");
      } else {
        setComparisonCount(explicitComparisonCount());
        setMessage("Producer DNA aj obľúbené patterny sa importovali. Osobný prior môžeš znovu natrénovať z ★ dát.");
      }
    } catch {
      setMessage("Lokálny import Producer DNA sa nepodaril.");
    } finally {
      setMemoryBusy(false);
    }
  };

  return (
    <section className="intent-song-draft" aria-label="Producer DNA A/B comparison">
      <div className="intent-detected">
        Producer DNA · vyber, ktorý take by si si nechal. Toto učí osobný vkus, nie hodnotenie plnenia briefu.
      </div>
      <div className="intent-candidate-row">
        <span>
          {referenceCandidate
            ? "Porovnaj pôvodný take s iteráciou; strany A/B sú skryté do uloženia voľby."
            : "Automatický návrh hľadá podobne vysoko vybrané take-y s jedným merateľným rozdielom."}
        </span>
        {!referenceCandidate && (
          <button
            type="button"
            className="btn btn-small"
            onClick={suggestProbe}
            disabled={blindProbeActive || blindPilotResultHidden}
          >
            NAVRHNÚŤ TASTE PROBE
          </button>
        )}
        {!referenceCandidate && blindPilotArmed && (
          <small>Blind pilot je pripravený pre nasledujúci nový bank; aktuálny výsledok zostáva bežným náhľadom.</small>
        )}
        {!referenceCandidate && !blindPilotArmed && !blindPilotPair && (
          <small>
            Blind pilot čaká, kým globálny a osobný ranker vyberú odlišných kandidátov s jednoznačným skóre.
          </small>
        )}
      </div>
      {!blindProbeActive && !blindPilotResultHidden && (
        <div className="intent-candidates" aria-label="Choose candidates to compare">
          {comparisonCandidates.map((candidate, position) => (
            <div className="intent-candidate-row" key={candidate.candidateIndex}>
              <span className="intent-candidate-index">
                {candidate.candidateIndex === -1
                  ? "PÔVODNÝ TAKE"
                  : `#${position + 1} · ${candidate.source === "symbolic-prior" ? "PRIOR" : "TPL"}`}
              </span>
              <button
                type="button"
                className={`btn btn-small${aIndex === candidate.candidateIndex ? " intent-use-btn" : ""}`}
                aria-pressed={aIndex === candidate.candidateIndex}
                onClick={() => selectA(candidate.candidateIndex)}
              >
                A
              </button>
              <button
                type="button"
                className={`btn btn-small${bIndex === candidate.candidateIndex ? " intent-use-btn" : ""}`}
                aria-pressed={bIndex === candidate.candidateIndex}
                onClick={() => selectB(candidate.candidateIndex)}
              >
                B
              </button>
            </div>
          ))}
        </div>
      )}

      {candidateA && candidateB && (
        <div className="intent-candidate-row" aria-label="Vote on A/B comparison">
          <strong>Ktorý take by si nechal?</strong>
          <span>
            {blindProbeActive
              ? "A"
              : candidateA.candidateIndex === -1
                ? "A · pôvodný take"
                : `A #${candidateA.candidateIndex + 1}`}
          </span>
          <button type="button" className="btn btn-small" onClick={() => onAudition(candidateA)}>
            ▶ A
          </button>
          <span>vs</span>
          <button type="button" className="btn btn-small" onClick={() => onAudition(candidateB)}>
            ▶ B
          </button>
          <span>
            {blindProbeActive
              ? "B"
              : candidateB.candidateIndex === -1
                ? "B · pôvodný take"
                : `B #${candidateB.candidateIndex + 1}`}
          </span>
          {!blindPilotActive && (
            <select
              aria-label="Optional reason for preference"
              value={reason}
              onChange={(event) => setReason(event.target.value as PreferenceReason | "")}
            >
              <option value="">Prečo? (voliteľné)</option>
              {REASONS.map((item) => (
                <option
                  key={item.value}
                  value={item.value}
                  disabled={
                    !isPreferenceReasonRankable(item.value) ||
                    (isAudioPreferenceReason(item.value) &&
                      !supportsAudioPreferenceReason(item.value, candidateA.audioFeatures, candidateB.audioFeatures))
                  }
                >
                  {item.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-small" onClick={() => vote("a")} disabled={!learningEnabled}>
            Nechal by som A
          </button>
          <button type="button" className="btn btn-small" onClick={() => vote("b")} disabled={!learningEnabled}>
            Nechal by som B
          </button>
          <button type="button" className="btn btn-small" onClick={() => vote("neither")} disabled={!learningEnabled}>
            Ani jeden
          </button>
          <button type="button" className="btn btn-small" onClick={() => vote("both")} disabled={!learningEnabled}>
            Oba dobré
          </button>
          {blindProbeActive && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                if (candidateA && candidateB) {
                  const pairKey = tasteProbePairKey(candidateA.contentHash, candidateB.contentHash);
                  setSkippedProbePairs((previous) => new Set([...previous, pairKey]));
                  const eventLineageId =
                    lineageId ?? referenceCandidate?.contentHash ?? candidates[0]?.contentHash ?? null;
                  const eventContext = { sessionId: currentProducerMemorySessionId(), lineageId: eventLineageId };
                  recordProducerMemoryWorkflowEvent("dismiss", candidateA.contentHash, eventContext);
                  recordProducerMemoryWorkflowEvent("dismiss", candidateB.contentHash, eventContext);
                }
                // A dismissed question resets the streak: the panel asks once,
                // then waits again instead of nudging.
                noteProbeDismissed();
                setBlindProbeActive(false);
                const wasBlindPilot = blindPilotActive;
                setBlindPilotActive(false);
                setBlindPilotGlobalSide(null);
                setBlindPilotResultHidden(false);
                onBlindPilotVisibilityChange?.(false);
                setAIndex(null);
                setBIndex(null);
                setReason("");
                setMessage(
                  wasBlindPilot
                    ? "Blind pilot zrušený; voľba sa neuložila."
                    : "Slepé porovnanie zrušené; teraz môžeš zvoliť ľubovoľnú dvojicu.",
                );
              }}
            >
              Zrušiť slepé porovnanie
            </button>
          )}
        </div>
      )}

      <div className="intent-candidate-row">
        <span title="DNA export obsahuje aj ★ patterny a ich hudobný obsah; seed a názvy trackov anonymizuje.">
          {comparisonCount} explicitných A/B volieb · export zahŕňa aj ★ patterny
        </span>
        <button type="button" className="btn btn-small" onClick={toggleLearning}>
          Učenie {learningEnabled ? "zapnuté" : "pozastavené"}
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Balík obsahuje lokálne voľby, opravy, vetvy, ★ patterny a štýlové príklady. Patterny zahŕňajú ich hudobný obsah; seed a názvy trackov sa anonymizujú. Bez promptov, názvov projektov a audia."
          onClick={() => void downloadPack()}
          disabled={memoryBusy || blindPilotActive}
        >
          Export DNA
        </button>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => importInput.current?.click()}
          disabled={memoryBusy || blindPilotActive}
        >
          Import DNA
        </button>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          aria-label="Import Producer DNA JSON"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void importPack(file);
          }}
        />
        <button
          type="button"
          className="btn btn-small"
          onClick={() => void clear()}
          disabled={memoryBusy || blindPilotActive}
        >
          Vymazať DNA
        </button>
      </div>
      {message && (
        <div role="status" className="intent-detected">
          {message}
        </div>
      )}
    </section>
  );
}
