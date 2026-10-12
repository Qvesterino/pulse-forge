import type { ReactElement } from "react";
import { CandidateIterationActions } from "../CandidateIterationActions";
import type { GenerationResult, RankedCandidate } from "../../intent/types";

/**
 * F4 collaborator — the candidate bank (▶ audition render cache, PRIOR/TPL
 * provenance, search lane, ★ best, USE).
 *
 * Extracted verbatim from IntentPanel. Pure renderer: it holds no audition
 * state, starts no render, and mutates nothing. The shell still owns the
 * audition cache (`playingIndex`/`renderingIndex`) and every command.
 */
export interface CandidateBankProps {
  /** Blind-pilot mode hides the bank so an unlabelled sample cannot be picked by position. */
  hidden: boolean;
  candidates: readonly RankedCandidate[] | null;
  bankResult: GenerationResult | null;
  playingIndex: number | null;
  renderingIndex: number | null;
  onToggleAudition: (candidate: RankedCandidate) => void;
  onUseCandidate: (candidate: RankedCandidate | null) => void;
  /** Regenerate from this candidate's own prompt, replaying the run. */
  onIterate: (prompt: string) => void;
  /** Shell-side guard: refuses a preview whose doc moved under it. */
  onSendToAudiotool: (candidate: RankedCandidate) => void;
}

export function CandidateBank(props: CandidateBankProps): ReactElement | null {
  const {
    hidden,
    candidates,
    bankResult,
    playingIndex,
    renderingIndex,
    onToggleAudition,
    onUseCandidate,
    onIterate,
    onSendToAudiotool,
  } = props;
  if (hidden || !candidates || candidates.length === 0) return null;
  return (
    <div className="intent-candidates" aria-label="Candidate bank">
      {candidates.map((candidate) => {
        const isWinner = candidate.candidateIndex === bankResult?.bank?.[0]?.candidateIndex;
        const isPlaying = playingIndex === candidate.candidateIndex;
        const isRendering = renderingIndex === candidate.candidateIndex;
        return (
          <div key={candidate.candidateIndex} className={`intent-candidate-row${isWinner ? " winner" : ""}`}>
            <button
              type="button"
              className="btn btn-small intent-audition-btn"
              onClick={() => onToggleAudition(candidate)}
              title={isPlaying ? "Stop audition" : "Audition this candidate"}
            >
              {isRendering ? "…" : isPlaying ? "■" : "▶"}
            </button>
            <span className="intent-candidate-meta">
              <span className="intent-candidate-index">#{candidates.indexOf(candidate) + 1}</span>
              <span
                className={`intent-candidate-source ${candidate.source}`}
                title={
                  candidate.source === "symbolic-prior"
                    ? "PRIOR — drums came from the symbolic-prior model (semantic/v2/v3 conditioning on your prompt, falling back to the genre+style one-hot). The model chose the grid."
                    : "TPL — drums came from the groove template, not the model. Happens when the groove is outside the prior's fixed vocabulary and no semantic conditioning is available; the generator never guesses a grid, it falls back safely."
                }
              >
                {candidate.source === "symbolic-prior" ? "PRIOR" : "TPL"}
              </span>
              {candidate.search && (
                <span
                  className={`intent-candidate-lane ${candidate.search.lane}`}
                  title={`Search policy: ${candidate.search.mode}; family: ${candidate.search.family}${
                    candidate.search.melodyFamily ? `; melody: ${candidate.search.melodyFamily}` : ""
                  }${candidate.search.family === "personal-groove" ? "; selected for your learned groove preference" : ""}${
                    candidate.search.grooveId ? ` (${candidate.search.grooveId})` : ""
                  }${
                    candidate.search.melodyFamily === "evolving-hook"
                      ? "; repeating lead motif with alternating cadence space"
                      : ""
                  }`}
                >
                  {candidate.search.lane.toUpperCase()}
                  {candidate.search.grooveId && " · GROOVE"}
                  {candidate.search.melodyFamily === "repeating-hook" && " · HOOK"}
                  {candidate.search.melodyFamily === "evolving-hook" && " · HOOK VARIATION"}
                </span>
              )}
              {isWinner && <span className="intent-candidate-win">★ best</span>}
              {candidate.status === "repaired" && <span className="intent-candidate-fixed">fixed</span>}
            </span>
            <button
              type="button"
              className="btn btn-small intent-use-btn"
              onClick={() => onUseCandidate(candidate)}
              title="Apply this candidate to the project (one undo step)"
            >
              USE
            </button>
            <CandidateIterationActions
              candidatePosition={candidates.indexOf(candidate)}
              onIterate={(prompt) => onIterate(prompt)}
            />
            {!window.kyxDesktop?.isDesktop && (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => onSendToAudiotool(candidate)}
                title="Review and explicitly send this exact candidate to an Audiotool project"
              >
                AUDIOTOOL
              </button>
            )}
          </div>
        );
      })}
      <p className="intent-candidate-legend">
        <span className="intent-candidate-source symbolic-prior">PRIOR</span> bicie z modelu
        {" · "}
        <span className="intent-candidate-source template">TPL</span> bicie zo šablóny — groove je mimo slovníka prioru
        a bez sémantického podmienenia. Generátor nikdy nedohaduje mriežku, bezpečne padá späť.
      </p>
    </div>
  );
}
