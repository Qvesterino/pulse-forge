import type { GenerationPlan, RankedCandidate, RankerSelectionMeta } from "../intent/types";
import { searchLaneForCandidate, type SearchLane } from "../intent/candidate-search";

interface CandidateLaneReceiptProps {
  plan: Pick<GenerationPlan, "candidateSeeds" | "symbolicSeeds">;
  candidates: readonly RankedCandidate[];
  warnings: readonly string[];
  selection?: Pick<RankerSelectionMeta, "audioRerank">;
}

const LANES: readonly SearchLane[] = ["safe", "personal", "experimental"];
const LANE_NAMES: Record<SearchLane, string> = {
  safe: "SAFE",
  personal: "PERSONAL",
  experimental: "EXPERIMENTAL",
};

function candidateDescription(candidate: RankedCandidate): string {
  const search = candidate.search;
  if (!search) return "lokálny kandidát bez lane metadát";

  const descriptions: string[] = [];
  if (search.family === "baseline") descriptions.push("základný smer");
  if (search.family === "soft-axis") descriptions.push("seedovaný variant intentu");
  if (search.family === "alternate-groove") {
    descriptions.push(`alternatívny groove${search.grooveId ? `: ${search.grooveId}` : ""}`);
  }
  if (search.family === "personal-groove") {
    if (typeof search.measuredSyncopationDelta === "number" && Number.isFinite(search.measuredSyncopationDelta)) {
      const delta = search.measuredSyncopationDelta;
      const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
      descriptions.push(`synkopácia ${sign}${Math.round(Math.abs(delta) * 100)} p. b. oproti SAFE`);
    } else {
      descriptions.push("groove podľa osobného signálu");
    }
  }
  if (search.family === "evolving-hook" && search.melodyFamily !== "evolving-hook") {
    descriptions.push("obmieňaná kadencia hooku");
  }
  if (search.melodyFamily === "repeating-hook") descriptions.push("opakujúci sa hook");
  if (search.melodyFamily === "evolving-hook") descriptions.push("obmieňaná kadencia hooku");
  if (search.mode === "cold-start") descriptions.push("cold-start — zatiaľ bez použiteľného osobného feedbacku");
  else if (search.lane === "personal" && search.mode === "personalized") {
    descriptions.push("smer podľa explicitných osobných volieb");
  }
  return descriptions.join(" · ") || "lokálny variant";
}

function candidateFailureLabel(warnings: readonly string[], candidateIndices: readonly number[]): string {
  const failures = warnings.filter((warning) => {
    const detail = warning.replace(/^candidate-bank-skipped:/, "");
    const match = detail.match(/(?:^|:)candidate-(\d+):/);
    return match ? candidateIndices.includes(Number(match[1])) : false;
  });

  if (failures.some((failure) => failure.includes("personal-groove-direction-not-realized"))) {
    return "osobný groove smer sa nepodarilo zrealizovať v platnom take";
  }
  if (failures.some((failure) => failure.includes("personal-groove-missing-safe-measurement"))) {
    return "nepodarilo sa zmerať SAFE groove baseline";
  }
  if (failures.some((failure) => failure.includes("invariant-gate"))) {
    return "variant neprešiel hard validáciou";
  }
  if (failures.some((failure) => failure.includes("generator-error"))) {
    return "generátor nedokázal vytvoriť platný variant";
  }
  return "nezostal samostatný platný take; variant mohol byť odmietnutý alebo zhodný s iným";
}

export function CandidateLaneReceipt({ plan, candidates, warnings, selection }: CandidateLaneReceiptProps) {
  const plannedCount = plan.candidateSeeds.length + plan.symbolicSeeds.length;
  if (plannedCount < 2) return null;

  const audioRerank = selection?.audioRerank;
  const audioWinnerPosition = audioRerank
    ? candidates.findIndex((candidate) => candidate.candidateIndex === audioRerank.selectedCandidateIndex)
    : -1;
  const displacedPosition = audioRerank
    ? candidates.findIndex((candidate) => candidate.candidateIndex === audioRerank.displacedCandidateIndex)
    : -1;

  const plannedIndices = Array.from({ length: plannedCount }, (_, index) => index);
  const lanes = LANES.map((lane) => {
    const laneIndices = plannedIndices.filter((index) => searchLaneForCandidate(index) === lane);
    const laneCandidates = candidates.filter((candidate) => candidate.search?.lane === lane);
    const detail =
      laneCandidates.length > 0
        ? [...new Set(laneCandidates.map(candidateDescription))].join("; ")
        : laneIndices.length > 0
          ? candidateFailureLabel(warnings, laneIndices)
          : "tento smer nebol v tomto behu plánovaný";
    return { lane, candidates: laneCandidates, detail, planned: laneIndices.length > 0 };
  });
  const candidateCountLabel = (count: number) =>
    count === 1 ? "1 platný kandidát" : count < 5 ? `${count} platné kandidáty` : `${count} platných kandidátov`;

  return (
    <section className="intent-lane-receipt" aria-label="Stav kreatívnych smerov">
      <div className="intent-lane-receipt-heading">KREATÍVNE SMERY · čo sa v tomto behu naozaj podarilo vytvoriť</div>
      <ul className="intent-lane-receipt-list">
        {lanes.map(({ lane, candidates: laneCandidates, detail, planned }) => (
          <li
            key={lane}
            className={`intent-lane-receipt-item ${laneCandidates.length > 0 ? "available" : planned ? "missing" : "not-planned"}`}
          >
            <strong>{LANE_NAMES[lane]}</strong>
            <span className="intent-lane-receipt-count">
              {laneCandidates.length > 0
                ? candidateCountLabel(laneCandidates.length)
                : planned
                  ? "bez výsledku"
                  : "neplánovaný"}
            </span>
            <span className="intent-lane-receipt-detail">{detail}</span>
          </li>
        ))}
      </ul>
      {audioRerank && audioWinnerPosition >= 0 && displacedPosition >= 0 && (
        <p className="intent-lane-receipt-audio" aria-label="Audio rerank explanation">
          Zvukový fit posunul kandidáta #{audioWinnerPosition + 1} pred #{displacedPosition + 1}. Je to technický
          signál, nie objektívna známka kvality.
        </p>
      )}
    </section>
  );
}
