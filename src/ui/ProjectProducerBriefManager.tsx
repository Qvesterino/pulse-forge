import type { ProjectProducerBriefFact, ProjectProducerBriefV1 } from "../project-model/types";

const FIELD_LABEL: Record<ProjectProducerBriefFact["field"], string> = {
  genre: "Žáner",
  style: "Štýl",
  mood: "Nálada",
  bpmRange: "Tempo",
  key: "Tónina",
  length: "Dĺžka",
  roles: "Generovať",
  energy: "Energia",
  density: "Hustota",
  complexity: "Komplexita",
  variation: "Variácia",
  preserve: "Zachovať",
  prohibitedRoles: "Nevytvárať",
};

const ROLE_LABEL: Record<string, string> = {
  drums: "bicie",
  bass: "basu",
  chords: "akordy",
  lead: "lead",
};

function factValue(fact: ProjectProducerBriefFact): string {
  switch (fact.field) {
    case "bpmRange":
      return fact.value[0] === fact.value[1] ? `${fact.value[0]} BPM` : `${fact.value[0]}–${fact.value[1]} BPM`;
    case "key":
      return fact.value;
    case "length":
      return `${fact.value / 16} taktov`;
    case "roles":
    case "preserve":
    case "prohibitedRoles":
      return fact.value.map((role) => ROLE_LABEL[role] ?? role).join(", ");
    case "energy":
    case "density":
    case "complexity":
    case "variation":
      return `${Math.round(fact.value * 100)} %`;
    case "genre":
    case "style":
    case "mood":
      return fact.value;
  }
}

interface ProjectProducerBriefManagerProps {
  brief: ProjectProducerBriefV1;
  onRemove: (field: ProjectProducerBriefFact["field"]) => void;
  onClear: () => void;
}

/** Inspect and forget project-local AI context without deleting the project. */
export function ProjectProducerBriefManager({ brief, onRemove, onClear }: ProjectProducerBriefManagerProps) {
  return (
    <details className="project-brief-manager" aria-label="Saved project Producer Brief facts">
      <summary>
        PROJECT MEMORY · {brief.facts.length} FACTS · UPDATED {new Date(brief.savedAt).toLocaleDateString()}
      </summary>
      <ul className="project-brief-fact-list">
        {brief.facts.map((fact) => (
          <li className="project-brief-fact" key={fact.field}>
            <span className="project-brief-fact-copy">
              <strong>{FIELD_LABEL[fact.field]}</strong>
              <span>{factValue(fact)}</span>
              <small>
                {fact.origin === "user" ? "potvrdené tebou" : "rozpoznané zo zadania"} · {fact.confidence}
              </small>
            </span>
            <button
              type="button"
              className="btn btn-small project-brief-forget"
              aria-label={`Remove saved project brief fact: ${fact.field}`}
              title={`Forget only “${FIELD_LABEL[fact.field]}”; Undo restores it`}
              onClick={() => onRemove(fact.field)}
            >
              FORGET
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-small project-brief-clear-all" onClick={onClear}>
        CLEAR ALL PROJECT MEMORY
      </button>
    </details>
  );
}
