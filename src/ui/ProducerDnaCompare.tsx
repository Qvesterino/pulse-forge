import { useEffect, useMemo, useState } from "react";
import { extractPatternFeatures } from "../ai/features/pattern-features";
import type { ProjectDocument } from "../project-model/types";
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
  { value: "bass", label: "basa (ranker zatiaľ nemeria)" },
  { value: "harmony", label: "harmónia (ranker zatiaľ nemeria)" },
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
  const [learningEnabled, setLearningEnabled] = useState(isPreferenceLearningEnabled);
  const [comparisonCount, setComparisonCount] = useState(() => readPreferenceLedger().length);
  const [message, setMessage] = useState("");

  const context = useMemo(() => preferenceContextForIntent(result.plan.intent), [result.plan.intent]);
  const candidateA = candidates.find((candidate) => candidate.candidateIndex === aIndex) ?? null;
  const candidateB = candidates.find((candidate) => candidate.candidateIndex === bIndex) ?? null;

  useEffect(() => {
    setAIndex(null);
    setBIndex(null);
    setReason("");
    setMessage("");
  }, [result]);

  const selectA = (index: number) => {
    setAIndex(index);
    if (bIndex === index) setBIndex(null);
    setMessage("");
  };
  const selectB = (index: number) => {
    setBIndex(index);
    if (aIndex === index) setAIndex(null);
    setMessage("");
  };

  const vote = (choice: PreferenceChoice) => {
    if (!candidateA || !candidateB || !learningEnabled) return;
    const batch = candidates.map((candidate) => candidate.pattern);
    const featuresFor = (candidate: RankedCandidate) =>
      extractPatternFeatures({
        doc: project,
        pattern: candidate.pattern,
        intent: result.plan.intent,
        options: result.plan.options,
        resolvedBpm: result.plan.resolvedBpm,
        batch,
      }).values;
    const observation = createPreferenceObservation(
      context,
      {
        contentHash: candidateA.contentHash,
        features: featuresFor(candidateA),
        globalScore: candidateA.globalScore,
        globalScoreVersion: candidateA.globalScoreVersion,
      },
      {
        contentHash: candidateB.contentHash,
        features: featuresFor(candidateB),
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

      {candidateA && candidateB && (
        <div className="intent-candidate-row" aria-label="Vote on A/B comparison">
          <strong>Ktorý take by si nechal?</strong>
          <span>A #{candidateA.candidateIndex + 1}</span>
          <button type="button" className="btn btn-small" onClick={() => onAudition(candidateA)}>
            ▶ A
          </button>
          <span>vs</span>
          <button type="button" className="btn btn-small" onClick={() => onAudition(candidateB)}>
            ▶ B
          </button>
          <span>B #{candidateB.candidateIndex + 1}</span>
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
