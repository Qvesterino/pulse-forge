import { useEffect, useMemo, useRef, useState } from "react";
import { extractPatternFeaturesV2 } from "../ai/features/pattern-features-v2";
import type { ProjectDocument } from "../project-model/types";
import { orderTasteProbeSides, suggestTasteProbePair, tasteProbePairKey } from "../intent/taste-probe";
import { isPreferenceReasonRankable } from "../intent/personal-ranker";
import {
  buildPreferenceLedgerPack,
  clearPreferenceLedger,
  createPreferenceObservation,
  isPreferenceLearningEnabled,
  preferenceContextForIntent,
  readPreferenceLedger,
  recordPreferenceObservation,
  setPreferenceLearningEnabled,
  type PreferenceChoice,
  type PreferenceReason,
} from "../intent/preference-ledger";
import type { GenerationResult, RankedCandidate } from "../intent/types";

interface ProducerDnaCompareProps {
  project: ProjectDocument;
  result: GenerationResult;
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
];

function downloadPack(): void {
  const pack = buildPreferenceLedgerPack();
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "kyx-producer-dna-v1.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export function ProducerDnaCompare({ project, result, onAudition }: ProducerDnaCompareProps) {
  const candidates = result.bank ?? [];
  const [aIndex, setAIndex] = useState<number | null>(null);
  const [bIndex, setBIndex] = useState<number | null>(null);
  const [reason, setReason] = useState<PreferenceReason | "">("");
  const [blindProbeActive, setBlindProbeActive] = useState(false);
  const [skippedProbePairs, setSkippedProbePairs] = useState<ReadonlySet<string>>(() => new Set());
  const [learningEnabled, setLearningEnabled] = useState(isPreferenceLearningEnabled);
  const [comparisonCount, setComparisonCount] = useState(() => readPreferenceLedger().length);
  const [message, setMessage] = useState("");
  const featureCache = useRef<{
    result: GenerationResult;
    project: ProjectDocument;
    rows: Map<number, Float32Array>;
  } | null>(null);

  const context = useMemo(() => preferenceContextForIntent(result.plan.intent), [result.plan.intent]);
  const candidateA = candidates.find((candidate) => candidate.candidateIndex === aIndex) ?? null;
  const candidateB = candidates.find((candidate) => candidate.candidateIndex === bIndex) ?? null;
  const candidateFeatures = (requested: readonly RankedCandidate[]) => {
    const cache =
      featureCache.current?.result === result && featureCache.current.project === project
        ? featureCache.current
        : { result, project, rows: new Map<number, Float32Array>() };
    const batch = candidates.map((candidate) => candidate.pattern);
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
    setSkippedProbePairs(new Set());
    setMessage("");
  }, [result]);

  const selectA = (index: number) => {
    setBlindProbeActive(false);
    setAIndex(index);
    setReason("");
    if (bIndex === index) setBIndex(null);
    setMessage("");
  };
  const selectB = (index: number) => {
    setBlindProbeActive(false);
    setBIndex(index);
    setReason("");
    if (aIndex === index) setAIndex(null);
    setMessage("");
  };

  const vote = (choice: PreferenceChoice) => {
    if (!candidateA || !candidateB || !learningEnabled) return;
    const features = candidateFeatures([candidateA, candidateB]);
    const observation = createPreferenceObservation(
      context,
      {
        contentHash: candidateA.contentHash,
        features: features.get(candidateA.candidateIndex) ?? [],
        globalScore: candidateA.globalScore,
        globalScoreVersion: candidateA.globalScoreVersion,
      },
      {
        contentHash: candidateB.contentHash,
        features: features.get(candidateB.candidateIndex) ?? [],
        globalScore: candidateB.globalScore,
        globalScoreVersion: candidateB.globalScoreVersion,
      },
      choice,
      reason ? { reason } : {},
    );
    if (!observation || !recordPreferenceObservation(observation)) {
      setMessage("Voľbu sa nepodarilo uložiť lokálne.");
      return;
    }
    const preferred = choice === "a" ? "A" : "B";
    if (choice === "neither") {
      setMessage("Uložené ako ‘ani jeden’ — bez učenia smeru.");
    } else if (choice === "both") {
      setMessage("Uložené ako ‘oba dobré’ — bez učenia smeru.");
    } else if (reason && !isPreferenceReasonRankable(reason)) {
      setMessage(`Voľba ${preferred} je uložená, ale tento ranker zatiaľ nemá feature osi pre „${reason}“.`);
    } else if (reason) {
      setMessage(
        `Voľba ${preferred} uložená pre „${reason}“; táto os sa použije po aspoň 2 relevantných porovnaniach.`,
      );
    } else {
      setMessage(`Voľba ${preferred} uložená ako všeobecná preferencia; učenie sa aktivuje po aspoň 2 porovnaniach.`);
    }
    setComparisonCount(readPreferenceLedger().length);
    setAIndex(null);
    setBIndex(null);
    setReason("");
    setBlindProbeActive(false);
  };

  const suggestProbe = () => {
    const features = candidateFeatures(candidates);
    const previouslyCompared = readPreferenceLedger()
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
    setLearningEnabled(next);
    setMessage(next ? "Lokálne učenie zapnuté." : "Lokálne učenie pozastavené.");
  };

  const clear = () => {
    if (!window.confirm("Vymazať všetky lokálne Producer DNA porovnania? Táto akcia sa nedá vrátiť.")) return;
    clearPreferenceLedger();
    setComparisonCount(0);
    setMessage("Lokálne porovnania boli vymazané.");
  };

  return (
    <section className="intent-song-draft" aria-label="Producer DNA A/B comparison">
      <div className="intent-detected">
        Producer DNA · vyber, ktorý take by si si nechal. Toto učí osobný vkus, nie hodnotenie plnenia briefu.
      </div>
      <div className="intent-candidate-row">
        <span>Automatický návrh hľadá podobne vysoko vybrané take-y s jedným merateľným rozdielom.</span>
        <button type="button" className="btn btn-small" onClick={suggestProbe}>
          NAVRHNÚŤ TASTE PROBE
        </button>
      </div>
      {!blindProbeActive && (
        <div className="intent-candidates" aria-label="Choose candidates to compare">
          {candidates.map((candidate, position) => (
            <div className="intent-candidate-row" key={candidate.candidateIndex}>
              <span className="intent-candidate-index">
                #{position + 1} · {candidate.source === "symbolic-prior" ? "PRIOR" : "TPL"}
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
          <span>{blindProbeActive ? "A" : `A #${candidateA.candidateIndex + 1}`}</span>
          <button type="button" className="btn btn-small" onClick={() => onAudition(candidateA)}>
            ▶ A
          </button>
          <span>vs</span>
          <button type="button" className="btn btn-small" onClick={() => onAudition(candidateB)}>
            ▶ B
          </button>
          <span>{blindProbeActive ? "B" : `B #${candidateB.candidateIndex + 1}`}</span>
          <select
            aria-label="Optional reason for preference"
            value={reason}
            onChange={(event) => setReason(event.target.value as PreferenceReason | "")}
          >
            <option value="">Prečo? (voliteľné)</option>
            {REASONS.map((item) => (
              <option key={item.value} value={item.value} disabled={!isPreferenceReasonRankable(item.value)}>
                {item.label}
              </option>
            ))}
          </select>
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
                }
                setBlindProbeActive(false);
                setAIndex(null);
                setBIndex(null);
                setReason("");
                setMessage("Slepé porovnanie zrušené; teraz môžeš zvoliť ľubovoľnú dvojicu.");
              }}
            >
              Zrušiť slepé porovnanie
            </button>
          )}
        </div>
      )}

      <div className="intent-candidate-row">
        <span>{comparisonCount} lokálnych porovnaní · bez promptov, audia a projektu</span>
        <button type="button" className="btn btn-small" onClick={toggleLearning}>
          Učenie {learningEnabled ? "zapnuté" : "pozastavené"}
        </button>
        <button type="button" className="btn btn-small" onClick={downloadPack}>
          Export DNA
        </button>
        <button type="button" className="btn btn-small" onClick={clear}>
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
