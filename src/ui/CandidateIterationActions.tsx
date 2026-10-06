import { useState } from "react";

type IterationScope = "drums" | "melodic";

interface CandidateIterationActionsProps {
  /** Position in the ranked bank; session references use this same order. */
  candidatePosition: number;
  onIterate: (prompt: string) => void;
}

const ORDINALS = ["prvý", "druhý", "tretí", "štvrtý", "piaty", "šiesty", "siedmy", "ôsmy"] as const;

const DIRECTIONS = [
  { label: "Redšie", phrase: "menej husté" },
  { label: "Hustejšie", phrase: "hustejšie" },
  { label: "Jednoduchšie", phrase: "jednoduchšie" },
  { label: "Zložitejšie", phrase: "zložitejšie" },
  { label: "Viac opakovania", phrase: "opakujúcejšie" },
  { label: "Viac vývoja", phrase: "evolving" },
  { label: "Menej energie", phrase: "menej energie" },
  { label: "Viac energie", phrase: "viac energie" },
] as const;

/** One click makes a three-take, one-axis child of the selected candidate. */
export function CandidateIterationActions({ candidatePosition, onIterate }: CandidateIterationActionsProps) {
  const [scope, setScope] = useState<IterationScope>("drums");
  const ordinal = ORDINALS[candidatePosition];
  if (!ordinal) return null;

  const target = scope === "drums" ? "bicie" : "basu a akordy a melódiu";
  const preserve = scope === "drums" ? "nechaj basu a akordy a melódiu" : "nechaj bicie";

  return (
    <details className="intent-iteration-controls">
      <summary className="btn btn-small" title="Vytvoriť tri cielené pokračovania tohto kandidáta">
        ↻ ĎALEJ ROZVÍJAŤ
      </summary>
      <div className="intent-iteration-panel">
        <span className="intent-iteration-label">Meniť</span>
        <div className="intent-iteration-scopes" aria-label="Rozsah iterácie">
          <button
            type="button"
            className={`btn btn-small${scope === "drums" ? " intent-use-btn" : ""}`}
            aria-pressed={scope === "drums"}
            onClick={() => setScope("drums")}
          >
            Bicie
          </button>
          <button
            type="button"
            className={`btn btn-small${scope === "melodic" ? " intent-use-btn" : ""}`}
            aria-pressed={scope === "melodic"}
            onClick={() => setScope("melodic")}
          >
            Melodiku
          </button>
        </div>
        <span className="intent-iteration-label">Jedna os zámeru · 3 varianty</span>
        <div className="intent-iteration-directions" aria-label="Hudobná os iterácie">
          {DIRECTIONS.map((direction) => (
            <button
              key={direction.label}
              type="button"
              className="btn btn-small"
              title="Zmeniť jednu os zámeru; potom si vypočuj aj vedľajšie hudobné rozdiely"
              onClick={() => onIterate(`ten ${ordinal}, ${direction.phrase} ${target}, ${preserve}, 3 varianty`)}
            >
              {direction.label}
            </button>
          ))}
        </div>
        <span className="intent-iteration-footnote">
          Každý variant vychádza z tohto take-u. Druhý blok zostane zachovaný; zmenu si vypočuj.
        </span>
      </div>
    </details>
  );
}
