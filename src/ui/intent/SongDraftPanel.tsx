import type { ReactElement } from "react";
import { SONG_PREFERENCE_FOCUS_OPTIONS, type SongPreferenceFocus } from "../../ai/features/song-dramaturgy-v1";
import type { SearchLane } from "../../intent/candidate-search";
import type { ComposeResult } from "../../intent/compose";
import type { LoudnessRecommendation } from "../../intent/loudness";
import type { SectionPreferenceCandidate } from "../../intent/section-preferences";
import type { SongAudioReview } from "../../intent/song-audio-review";
import type { SongPreferenceCandidate } from "../../intent/song-preferences";
import type { SongBuild, SongBuildSection } from "../../intent/song";
import type { ProjectDocument } from "../../project-model/types";

/**
 * F4 collaborator — the ♪ SONG draft surface (preview, full-song lanes,
 * per-section A/B learning, loudness recommendation, technical review, revise).
 *
 * Extracted verbatim from IntentPanel: this component is a pure renderer. It
 * owns no audio state, starts no recording, and mutates nothing — every value
 * and every verb arrives as a prop from the panel shell, which still owns the
 * song state and all commands.
 */
export interface SongDraft {
  result: ComposeResult;
  /** Exact whole-song candidate currently auditioned and eligible for USE. */
  activeBuild: SongBuild;
  /** null means the legacy best-per-section composition. */
  activeLane: SearchLane | null;
  /** A selected coherent lane cannot be applied until its full-song render succeeds. */
  previewReady: boolean;
  /** Doc the draft was composed against — USE reuses the auditioned mix
      only while the doc is untouched (reference-equal); after interim
      edits the mix re-plans against the current doc (rebase). */
  baseDoc: ProjectDocument;
  previewDoc: ProjectDocument;
  mixNote: string;
  lengthNote: string;
  seconds: number;
  /** Preview loudness trim (master.loudnessTrimDb) — FÁZA 6: this is the
      RECOMMENDED trim until the user confirms; USE installs it only when
      loudnessApplied is true (confirm re-renders the audition trimmed). */
  trimDb: number;
  loudnessTarget: number;
  measuredBefore: number | null;
  /** Gated LUFS measured on the audition buffer itself (the free verify). */
  measuredAfter: number | null;
  loudnessApplied: boolean;
  /** Structured report (goal/evidence/trade-off) behind the recommendation. */
  loudnessRecommendation: LoudnessRecommendation | null;
  audioReview: SongAudioReview | null;
  /** Fully rendered, user-auditioned takes eligible for explicit song-level A/B. */
  preferenceTakes?: SongPreferenceTake[];
  /** Individual generated section takes, kept separate from song-level votes. */
  sectionPreferenceTakes?: SectionPreferenceTake[];
}

export interface SongPreferenceTake {
  id: string;
  label: string;
  candidate: SongPreferenceCandidate;
  auditioned: boolean;
}

export interface SectionPreferenceTake {
  id: string;
  label: string;
  sectionIndex: number;
  lane: SearchLane | null;
  candidate: SectionPreferenceCandidate;
  auditioned: boolean;
}

/** Producer-DNA evidence behind the whole-song direction tip. */
export interface SongPreferenceRank {
  lane: SearchLane | null;
  renderedLaneCount: number;
  comparisonCount: number;
  confidenceWeight: number;
  audioPreferenceApplied: boolean;
  dramaturgyComparisonCount: number;
  dramaturgyConfidenceWeight: number;
  dramaturgyPreferenceApplied: boolean;
}

/** Section-level alternatives that kept the baseline role and bar count. */
export const sectionPreferenceOptions = (draft: SongDraft, sectionIndex: number) => {
  const baseline = draft.result.build.sections[sectionIndex];
  if (!baseline) return [];
  const options = [
    {
      id: `${sectionIndex}:best`,
      label: "BEST PER SECTION",
      lane: null as SearchLane | null,
      candidateIndex: 0,
      section: baseline,
    },
    ...draft.result.build.alternatives.map((alternative, index) => ({
      id: `${sectionIndex}:${alternative.lane}`,
      label: alternative.lane.toUpperCase(),
      lane: alternative.lane,
      candidateIndex: index + 1,
      section: alternative.sections[sectionIndex],
    })),
  ];
  return options.filter(
    (option): option is (typeof options)[number] & { section: SongBuildSection } =>
      Boolean(option.section) && option.section.role === baseline.role && option.section.bars === baseline.bars,
  );
};

export type SectionCompareSelections = Record<string, { a: string; b: string }>;

/** Currently compared A/B pair for one section, falling back to the first two
    surviving options. Pure in `selections` so the shell and this renderer agree
    on which takes a recorded preference refers to. */
export const sectionCompareSelection = (
  selections: SectionCompareSelections,
  sectionIndex: number,
  options: ReturnType<typeof sectionPreferenceOptions>,
) => {
  const stored = selections[String(sectionIndex)];
  return {
    a: stored?.a ?? options[0]?.id ?? "",
    b: stored?.b ?? options[1]?.id ?? "",
  };
};

export interface SongDraftPanelProps {
  songDraft: SongDraft | null;
  songBusy: boolean;
  songRendering: boolean;
  songPlaying: boolean;
  /** `!songBufferRef.current` in the shell — the auditioned full song exists. */
  songBufferReady: boolean;
  /** `undefined` = Producer DNA is off; `null` = no lane tip, use per-section best. */
  songDnaTipLane: SearchLane | null | undefined;
  songDnaTipLabel: string;
  audioRank: SongPreferenceRank | null;
  learningEnabled: boolean;
  automaticLearning: boolean;
  songPreferenceFocus: SongPreferenceFocus;
  onSongPreferenceFocusChange: (focus: SongPreferenceFocus) => void;
  songCompareA: string;
  onSongCompareAChange: (value: string) => void;
  songCompareB: string;
  onSongCompareBChange: (value: string) => void;
  songComparisonReady: boolean;
  songFeedbackMessage: string | null;
  playingSectionId: string | null;
  renderingSectionId: string | null;
  sectionCompareSelections: SectionCompareSelections;
  onSectionCompareSelectionChange: (sectionIndex: number, next: { a: string; b: string }) => void;
  sectionFeedbackMessages: Record<string, string>;
  onToggleSongAudition: () => void;
  onAcceptLoudnessTrim: () => void;
  onDeclineLoudnessTrim: () => void;
  onUseSongDraft: () => void;
  onDiscardSongDraft: () => void;
  onSelectSongLane: (lane: SearchLane | null) => void;
  onRecordSongPreference: (choice: "a" | "b" | "neither" | "both") => void;
  onToggleSectionAudition: (section: SongBuildSection) => void;
  onPlaySectionPreferenceTake: (sectionIndex: number, optionId: string) => void;
  onRecordSectionPreference: (sectionIndex: number, choice: "a" | "b" | "neither" | "both") => void;
  onReviseSongDraft: (attribute: "energy" | "density", delta: number) => void;
  onBuildFreshSongDraft: () => void;
}

export function SongDraftPanel(props: SongDraftPanelProps): ReactElement | null {
  const {
    songDraft,
    songBusy,
    songRendering,
    songPlaying,
    songBufferReady,
    songDnaTipLane,
    songDnaTipLabel,
    audioRank,
    learningEnabled,
    automaticLearning,
    songPreferenceFocus,
    onSongPreferenceFocusChange,
    songCompareA,
    onSongCompareAChange,
    songCompareB,
    onSongCompareBChange,
    songComparisonReady,
    songFeedbackMessage,
    playingSectionId,
    renderingSectionId,
    sectionCompareSelections,
    onSectionCompareSelectionChange,
    sectionFeedbackMessages,
    onToggleSongAudition,
    onAcceptLoudnessTrim,
    onDeclineLoudnessTrim,
    onUseSongDraft,
    onDiscardSongDraft,
    onSelectSongLane,
    onRecordSongPreference,
    onToggleSectionAudition,
    onPlaySectionPreferenceTake,
    onRecordSectionPreference,
    onReviseSongDraft,
    onBuildFreshSongDraft,
  } = props;
  if (!songDraft) return null;
  return (
    <div className="intent-song-draft" aria-label="Song draft preview">
      <div className="intent-candidate-row winner">
        <button
          type="button"
          className="btn btn-small intent-audition-btn"
          disabled={songRendering || !songBufferReady}
          onClick={onToggleSongAudition}
          title={songPlaying ? "Stop song audition" : "Audition the full song"}
        >
          {songRendering ? "…" : songPlaying ? "■" : "▶"}
        </button>
        <span className="intent-candidate-meta">
          <span className="intent-candidate-index">{songDraft.activeBuild.name}</span>
          <span className="intent-candidate-score">
            {songDraft.activeBuild.sections.length} sections · {songDraft.activeBuild.totalBars} bars
            {songDraft.lengthNote} · {Math.round(songDraft.activeBuild.resolvedBpm ?? 120)} BPM ·{" "}
            {songDraft.activeBuild.candidateCount} candidates/section
            {songDraft.activeLane ? ` · ${songDraft.activeLane.toUpperCase()} full-song lane` : " · best per section"}
            {songDraft.loudnessApplied &&
              (songDraft.measuredAfter != null ? ` · plays ≈${songDraft.measuredAfter} LUFS` : " · loudness trim set")}
          </span>
        </span>
        {!songDraft.loudnessApplied && songDraft.trimDb !== 0 && songDraft.loudnessRecommendation && (
          <span className="loudness-recommendation" aria-label="Loudness recommendation">
            <span className="loudness-recommendation-text">
              🔊 {songDraft.loudnessRecommendation.evidence} · cieľ {songDraft.loudnessRecommendation.goal} —{" "}
              <b>navrhovaný trim {songDraft.trimDb} dB</b> ({songDraft.loudnessRecommendation.tradeOff})
            </span>
            <button
              type="button"
              className="btn btn-small section-proposal-apply"
              disabled={songRendering}
              onClick={() => void onAcceptLoudnessTrim()}
            >
              ✓ PRIJAŤ TRIM
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={songRendering}
              onClick={onDeclineLoudnessTrim}
              title="USE installs the untrimmed version"
            >
              ✗
            </button>
          </span>
        )}
        <button
          type="button"
          className="btn btn-small intent-use-btn"
          disabled={songBusy || songRendering}
          onClick={() => void onUseSongDraft()}
          title="Apply this song to the project (song + mix + loudness, undoable)"
        >
          USE SONG
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={songBusy}
          onClick={onDiscardSongDraft}
          title="Discard this draft — nothing is applied"
        >
          DROP
        </button>
      </div>
      {songDraft.result.build.candidateCount > 1 && (
        <div className="intent-share-actions" aria-label="Full-song directions">
          <button
            type="button"
            className={`btn btn-small${songDraft.activeLane === null ? " intent-use-btn" : ""}`}
            aria-pressed={songDraft.activeLane === null}
            disabled={songBusy || songRendering}
            onClick={() => void onSelectSongLane(null)}
            title="Use the current best-ranked choice independently selected for each section"
          >
            BEST PER SECTION{songDnaTipLane === null && audioRank ? ` · ${songDnaTipLabel}` : ""}
          </button>
          {songDraft.result.build.alternatives.map((alternative) => {
            const modeNote =
              alternative.mode === "cold-start"
                ? " · cold start"
                : alternative.mode === "personalized"
                  ? " · learned taste"
                  : alternative.mode === "mixed"
                    ? " · mixed context"
                    : "";
            const personalNote = songDnaTipLane === alternative.lane && audioRank ? ` · ${songDnaTipLabel}` : "";
            const label = `${alternative.lane.toUpperCase()}${modeNote}${personalNote}`;
            return (
              <button
                key={alternative.lane}
                type="button"
                className={`btn btn-small${songDraft.activeLane === alternative.lane ? " intent-use-btn" : ""}`}
                aria-label={`Use ${label} full-song direction`}
                aria-pressed={songDraft.activeLane === alternative.lane}
                disabled={songBusy || songRendering}
                onClick={() => void onSelectSongLane(alternative.lane)}
                title={`Audition the complete ${alternative.lane} direction, with the same lane carried through every section`}
              >
                {label}
              </button>
            );
          })}
          <small>
            Only complete, musically distinct alternatives are shown. USE stays disabled until a selected lane renders.
          </small>
          {audioRank ? (
            <>
              {audioRank.audioPreferenceApplied && (
                <small>
                  Sound DNA tip: {audioRank.lane?.toUpperCase() ?? "BEST PER SECTION"} spomedzi{" "}
                  {audioRank.renderedLaneCount} už renderovaných celých smerov · {audioRank.comparisonCount}{" "}
                  relevantných audio porovnaní · váha dôkazu {audioRank.confidenceWeight.toFixed(2)}.
                </small>
              )}
              {audioRank.dramaturgyPreferenceApplied && (
                <small>
                  Song form DNA tip: {audioRank.lane?.toUpperCase() ?? "BEST PER SECTION"} podľa formy a vývoja ·{" "}
                  {audioRank.dramaturgyComparisonCount} porovnaní · váha dôkazu{" "}
                  {audioRank.dramaturgyConfidenceWeight.toFixed(2)}.
                </small>
              )}
            </>
          ) : learningEnabled && songDraft.result.build.recommendedLane !== undefined ? (
            <small>
              Producer DNA odporúča {songDraft.result.build.recommendedLane?.toUpperCase() ?? "BEST PER SECTION"} podľa
              výslovných porovnaní celých skladieb.
            </small>
          ) : null}
        </div>
      )}
      {songDraft.result.build.candidateCount > 1 && songDraft.result.build.alternatives.length === 0 && (
        <div className="intent-detected" role="status">
          No complete alternate lane survived every section; this song uses the best-ranked candidate per section.
        </div>
      )}
      {(songDraft.preferenceTakes?.length ?? 0) >= 2 && (
        <div className="intent-share-actions" aria-label="Explicit full-song preference comparison">
          <strong>UČIŤ VÝBER CELEJ SKLADBY</strong>
          <span>Hlas sa odomkne až po dopočutí oboch kompletných renderov.</span>
          <label>
            ČO HODNOTÍŠ
            <select
              aria-label="Full-song preference focus"
              value={songPreferenceFocus}
              onChange={(event) => onSongPreferenceFocusChange(event.target.value as SongPreferenceFocus)}
            >
              {SONG_PREFERENCE_FOCUS_OPTIONS.map((focus) => (
                <option key={focus.value} value={focus.value}>
                  {focus.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            A
            <select
              aria-label="Full-song preference candidate A"
              value={songCompareA}
              onChange={(event) => onSongCompareAChange(event.target.value)}
            >
              {(songDraft.preferenceTakes ?? []).map((take) => (
                <option key={take.id} value={take.id}>
                  {take.label}
                  {take.auditioned ? " · vypočuté" : " · treba vypočuť"}
                </option>
              ))}
            </select>
          </label>
          <label>
            B
            <select
              aria-label="Full-song preference candidate B"
              value={songCompareB}
              onChange={(event) => onSongCompareBChange(event.target.value)}
            >
              {(songDraft.preferenceTakes ?? []).map((take) => (
                <option key={take.id} value={take.id}>
                  {take.label}
                  {take.auditioned ? " · vypočuté" : " · treba vypočuť"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onRecordSongPreference("a")}
            disabled={!automaticLearning || !songComparisonReady}
          >
            NECHAL BY SOM A
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onRecordSongPreference("b")}
            disabled={!automaticLearning || !songComparisonReady}
          >
            NECHAL BY SOM B
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onRecordSongPreference("neither")}
            disabled={!automaticLearning || !songComparisonReady}
          >
            ANI JEDEN
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onRecordSongPreference("both")}
            disabled={!automaticLearning || !songComparisonReady}
          >
            OBA DOBRÉ
          </button>
          {songFeedbackMessage && <span role="status">{songFeedbackMessage}</span>}
        </div>
      )}
      {songDraft.audioReview && (
        <div className="intent-song-audio-review" aria-label="Technical audio review">
          <div className="intent-song-audio-metrics">
            <strong>RENDER CHECK</strong>
            <span>Peak {songDraft.audioReview.peakDbfs.toFixed(1)} dBFS</span>
            <span>RMS {songDraft.audioReview.rmsDbfs.toFixed(1)} dBFS</span>
            <span>Crest {songDraft.audioReview.crestFactor.toFixed(2)}:1</span>
            <span title="Low-frequency energy proxy below approximately 200 Hz">
              Bass {Math.round(songDraft.audioReview.lowBandRatio * 100)}%
            </span>
          </div>
          {songDraft.audioReview.findings.length > 0 ? (
            <ul>
              {songDraft.audioReview.findings.map((finding) => (
                <li key={finding.code} title={finding.evidence}>
                  {finding.message}
                </li>
              ))}
            </ul>
          ) : (
            <span>No signal-health flags detected.</span>
          )}
          <small>Technical checks only — these metrics do not grade musicality.</small>
        </div>
      )}
      <div className="intent-song-sections" aria-label="Song sections">
        {songDraft.activeBuild.sections.map((section, sectionIndex) => {
          const id = section.pattern.id;
          const isPlaying = playingSectionId === id;
          const isRendering = renderingSectionId === id;
          const options = sectionPreferenceOptions(songDraft, sectionIndex);
          const selection = sectionCompareSelection(sectionCompareSelections, sectionIndex, options);
          const takeA = (songDraft.sectionPreferenceTakes ?? []).find(
            (take) => take.sectionIndex === sectionIndex && take.id === selection.a,
          );
          const takeB = (songDraft.sectionPreferenceTakes ?? []).find(
            (take) => take.sectionIndex === sectionIndex && take.id === selection.b,
          );
          const comparisonReady = Boolean(
            takeA?.auditioned && takeB?.auditioned && takeA.candidate.contentHash !== takeB.candidate.contentHash,
          );
          return (
            <div key={id} className="intent-candidate-row">
              <button
                type="button"
                className="btn btn-small intent-audition-btn"
                disabled={songBusy || songRendering || isRendering}
                onClick={() => void onToggleSectionAudition(section)}
                title={isPlaying ? `Stop ${section.label} preview` : `Audition ${section.label} alone`}
              >
                {isRendering ? "…" : isPlaying ? "■" : "▶"}
              </button>
              <span className="intent-candidate-score" title={section.roles.join("+")}>
                {section.label} · {section.bars}b · {section.roles.join("+")}
              </span>
              {options.length >= 2 && (
                <details className="intent-section-preference">
                  <summary>UČIŤ VÝBER TEJTO SEKCIE</summary>
                  <div className="intent-share-actions">
                    <label>
                      A
                      <select
                        aria-label={`${section.label} section preference candidate A`}
                        value={selection.a}
                        onChange={(event) =>
                          onSectionCompareSelectionChange(sectionIndex, { ...selection, a: event.target.value })
                        }
                      >
                        {options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                            {(songDraft.sectionPreferenceTakes ?? []).some(
                              (take) => take.sectionIndex === sectionIndex && take.id === option.id && take.auditioned,
                            )
                              ? " · vypočuté"
                              : " · treba vypočuť"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={songBusy || songRendering || renderingSectionId !== null}
                      onClick={() => void onPlaySectionPreferenceTake(sectionIndex, selection.a)}
                    >
                      {renderingSectionId === `preference:${selection.a}`
                        ? "… A"
                        : playingSectionId === `preference:${selection.a}`
                          ? "■ A"
                          : "▶ A"}
                    </button>
                    <label>
                      B
                      <select
                        aria-label={`${section.label} section preference candidate B`}
                        value={selection.b}
                        onChange={(event) =>
                          onSectionCompareSelectionChange(sectionIndex, { ...selection, b: event.target.value })
                        }
                      >
                        {options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                            {(songDraft.sectionPreferenceTakes ?? []).some(
                              (take) => take.sectionIndex === sectionIndex && take.id === option.id && take.auditioned,
                            )
                              ? " · vypočuté"
                              : " · treba vypočuť"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={songBusy || songRendering || renderingSectionId !== null}
                      onClick={() => void onPlaySectionPreferenceTake(sectionIndex, selection.b)}
                    >
                      {renderingSectionId === `preference:${selection.b}`
                        ? "… B"
                        : playingSectionId === `preference:${selection.b}`
                          ? "■ B"
                          : "▶ B"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!automaticLearning || !comparisonReady}
                      onClick={() => onRecordSectionPreference(sectionIndex, "a")}
                    >
                      NECHAL BY SOM A
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!automaticLearning || !comparisonReady}
                      onClick={() => onRecordSectionPreference(sectionIndex, "b")}
                    >
                      NECHAL BY SOM B
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!automaticLearning || !comparisonReady}
                      onClick={() => onRecordSectionPreference(sectionIndex, "neither")}
                    >
                      ANI JEDEN
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!automaticLearning || !comparisonReady}
                      onClick={() => onRecordSectionPreference(sectionIndex, "both")}
                    >
                      OBA DOBRÉ
                    </button>
                    {sectionFeedbackMessages[String(sectionIndex)] && (
                      <span role="status">{sectionFeedbackMessages[String(sectionIndex)]}</span>
                    )}
                    {!comparisonReady && <small>Hlas sa odomkne po dopočutí oboch samostatných renderov.</small>}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <div className="intent-share-actions" aria-label="Revise song draft">
        <button
          type="button"
          className="btn btn-small"
          disabled={songBusy}
          onClick={() => void onReviseSongDraft("energy", 0.15)}
          title="Same seed, more energy — audition again before USE"
        >
          E+
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={songBusy}
          onClick={() => void onReviseSongDraft("energy", -0.15)}
          title="Same seed, calmer — audition again before USE"
        >
          E−
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={songBusy}
          onClick={() => void onReviseSongDraft("density", 0.15)}
          title="Same seed, denser — audition again before USE"
        >
          D+
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={songBusy}
          onClick={() => void onReviseSongDraft("density", -0.15)}
          title="Same seed, sparser — audition again before USE"
        >
          D−
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={songBusy}
          onClick={() => onBuildFreshSongDraft()}
          title="Fresh seed — a different take on the same sentence"
        >
          ↻ FRESH
        </button>
      </div>
      <div className="intent-detected">
        After USE: type “make bridge more energetic” + ⚡ DO IT to revise one section in place.
      </div>
    </div>
  );
}
