import { useMemo, useState } from "react";
import {
  useActivePatternId,
  usePatterns,
  useScenes,
  useSelection,
  useSelectionStore,
  useServices,
  useTracks,
} from "./context";
import { assistBuild, assistFill, assistReplace, assistVary } from "../commands/commands";
import {
  assistThinSelectionCommand,
  assistVaryNoteSelectionCommand,
  assistVarySelectionCommand,
} from "../commands/assistSelectionCommands";
import {
  applyAssistPatchToStepSelection,
  classifyPads,
  humanizeNoteSelection,
  styleNames,
  thinStepSelection,
  type NoteSelectionScope,
  type ReplaceTarget,
  type StepSelectionScope,
} from "../assist/patternOps";
import { parseSelectedStepIntent, type SelectedStepIntent } from "../assist/selected-step-intent";
import { buildAssistPatch } from "../assist/pipeline";
import { ASSIST_ENGINE_VERSION, type AssistOperation } from "../assist/types";
import { getActivePattern, getDrumTrack } from "../project-model/types";
import { nextSeed } from "../shared/dice";
import { applyArrangeOps, parseArrangeIntent, type ParsedArrange } from "../intent/arrangeWords";

interface SelectedStepChange {
  padId: string;
  padName: string;
  step: number;
  before: number;
  after: number;
}

interface SelectedStepInstructionPlan {
  intent: SelectedStepIntent | null;
  scope: StepSelectionScope | null;
  changes: SelectedStepChange[];
  beforeHits: number;
  afterHits: number;
  error: string | null;
}

function randomSeed(prev?: string): string {
  return nextSeed(prev ?? String(Date.now()), "assist");
}

/**
 * Assist — iterate on YOUR pattern instead of regenerating from scratch.
 * Every operation is deterministic for a given seed (same seed = same
 * result), undoable as one gesture, and re-rolls the seed after applying so
 * pressing the button again gives a fresh take. That tight loop —
 * apply, listen, undo or iterate — is the whole point.
 */
export function AssistPanel({ onClose }: { onClose: () => void }) {
  const services = useServices();
  // Fine-grained selector (GOAL 04): AssistPanel reads scenes (UI gate),
  // and helper functions take the full doc (getActivePattern, getDrumTrack,
  // parseArrangeIntent). A plain getter gives us the doc; the scenes
  // subscription powers the conditional render of the scene-asser UI.
  const scenes = useScenes();
  const tracks = useTracks();
  const patterns = usePatterns();
  const activePatternId = useActivePatternId();
  const selection = useSelection();
  const selectionStore = useSelectionStore();
  const doc = services.store.getDoc();
  const pattern = patterns.find((candidate) => candidate.id === activePatternId) ?? getActivePattern(doc);
  const drumTracks = tracks.filter((track) => track.kind === "drum");
  const stepSelection = selection.stepSelection;
  const selectedDrumTrack = stepSelection
    ? drumTracks.find(
        (track) =>
          stepSelection.padIds.length > 0 &&
          stepSelection.padIds.every((padId) => track.pads.some((pad) => pad.id === padId)),
      )
    : undefined;
  const selectedStepScope =
    stepSelection &&
    selectedDrumTrack &&
    Number.isInteger(stepSelection.from) &&
    Number.isInteger(stepSelection.to) &&
    Math.min(stepSelection.from, stepSelection.to) >= 0 &&
    Math.max(stepSelection.from, stepSelection.to) < pattern.stepCount &&
    stepSelection.padIds.every((padId) => pattern.rows[padId] !== undefined)
      ? stepSelection
      : null;
  const selectedNoteScope = useMemo((): NoteSelectionScope[] | null => {
    if (selection.noteSelections.length === 0) return null;
    const scoped: NoteSelectionScope[] = [];
    for (const noteSelection of selection.noteSelections) {
      const noteIds = [...new Set(noteSelection.noteIds)];
      const trackExists = tracks.some((track) => track.id === noteSelection.trackId);
      const notes = pattern.notes[noteSelection.trackId];
      if (
        !trackExists ||
        noteIds.length === 0 ||
        !notes ||
        noteIds.some((noteId) => !notes.some((note) => note.id === noteId))
      ) {
        return null;
      }
      scoped.push({ trackId: noteSelection.trackId, noteIds });
    }
    return scoped;
  }, [pattern, selection.noteSelections, tracks]);
  const drumTrack = drumTracks[0] ?? getDrumTrack(doc);
  const drumPads = drumTrack.pads;
  const [seed, setSeed] = useState(randomSeed);
  const [amount, setAmount] = useState(0.6);
  const [bars, setBars] = useState(4);
  const [target, setTarget] = useState<ReplaceTarget>("hats");
  const [style, setStyle] = useState("house");
  const [previewOperation, setPreviewOperation] = useState<AssistOperation>("vary");
  const [flash, setFlash] = useState<string | null>(null);
  const [selectedStepText, setSelectedStepText] = useState("");
  const [arrangeText, setArrangeText] = useState("");
  const arrangeParsed: ParsedArrange | null = arrangeText.trim() ? parseArrangeIntent(arrangeText, doc) : null;
  const [arrangeApplied, setArrangeApplied] = useState<string | null>(null);

  const apply = (label: string, run: () => void) => {
    run();
    setFlash(`${label} · seed ${seed}`);
    setSeed((prev) => randomSeed(prev)); // next press = fresh take on the same idea
    setTimeout(() => setFlash(null), 2500);
  };

  const stylesForTarget = styleNames(target);
  const previewPatch = useMemo(
    () =>
      buildAssistPatch(pattern, drumPads, {
        operation: previewOperation,
        seed,
        amount,
        bars,
        target,
        style,
      }),
    [pattern, drumPads, previewOperation, seed, amount, bars, target, style],
  );
  const previewPad =
    drumPads.find((pad) => (previewPatch.rows[pad.id] ?? []).some((value) => value > 0)) ?? drumPads[0];
  const previewRow = previewPad ? (previewPatch.rows[previewPad.id] ?? []) : [];
  const selectedVariationPattern = useMemo(() => {
    if (!selectedStepScope || !selectedDrumTrack) return null;
    const patch = buildAssistPatch(pattern, selectedDrumTrack.pads, {
      operation: "vary",
      seed,
      amount,
      bars,
      target,
      style,
    });
    return applyAssistPatchToStepSelection(pattern, patch, selectedStepScope);
  }, [pattern, selectedDrumTrack, selectedStepScope, seed, amount, bars, target, style]);
  const selectedStepInstructionPlan = useMemo((): SelectedStepInstructionPlan => {
    if (!selectedStepText.trim()) {
      return { intent: null, scope: null, changes: [], beforeHits: 0, afterHits: 0, error: null };
    }
    if (!selectedStepScope || !selectedDrumTrack) {
      return {
        intent: null,
        scope: null,
        changes: [],
        beforeHits: 0,
        afterHits: 0,
        error: "Reselect valid drum cells before describing a scoped edit.",
      };
    }
    const intent = parseSelectedStepIntent(selectedStepText);
    if (!intent) {
      return {
        intent: null,
        scope: null,
        changes: [],
        beforeHits: 0,
        afterHits: 0,
        error: "Try “make selected hats sparser” or “humanize these steps”.",
      };
    }

    const selectedPadIds = new Set(selectedStepScope.padIds);
    const targetPads = intent.target ? classifyPads(selectedDrumTrack.pads)[intent.target] : selectedDrumTrack.pads;
    const padIds = targetPads.filter((pad) => selectedPadIds.has(pad.id)).map((pad) => pad.id);
    if (padIds.length === 0) {
      return {
        intent,
        scope: null,
        changes: [],
        beforeHits: 0,
        afterHits: 0,
        error: `The current step selection contains no ${intent.target ?? "usable"} drum rows.`,
      };
    }

    const scope: StepSelectionScope = { ...selectedStepScope, padIds };
    const previewPattern =
      intent.operation === "thin"
        ? thinStepSelection(pattern, scope)
        : applyAssistPatchToStepSelection(
            pattern,
            buildAssistPatch(pattern, selectedDrumTrack.pads, {
              operation: "vary",
              seed,
              amount,
              bars,
              target,
              style,
            }),
            scope,
          );
    if (previewPattern === pattern) {
      return {
        intent,
        scope,
        changes: [],
        beforeHits: 0,
        afterHits: 0,
        error:
          intent.operation === "thin"
            ? "The selected rows have no off-beat hits to thin."
            : "This instruction would not change the selected cells; try a new seed or a wider selection.",
      };
    }

    const from = Math.min(scope.from, scope.to);
    const to = Math.max(scope.from, scope.to);
    const changes: SelectedStepChange[] = [];
    let beforeHits = 0;
    let afterHits = 0;
    for (const padId of scope.padIds) {
      const padName = selectedDrumTrack.pads.find((pad) => pad.id === padId)?.name ?? "selected row";
      const before = pattern.rows[padId] ?? [];
      const after = previewPattern.rows[padId] ?? [];
      for (let step = from; step <= to; step++) {
        const beforeVelocity = before[step] ?? 0;
        const afterVelocity = after[step] ?? 0;
        if (beforeVelocity > 0) beforeHits++;
        if (afterVelocity > 0) afterHits++;
        if (beforeVelocity !== afterVelocity)
          changes.push({ padId, padName, step, before: beforeVelocity, after: afterVelocity });
      }
    }
    if (changes.length === 0) {
      return {
        intent,
        scope,
        changes,
        beforeHits,
        afterHits,
        error: "This instruction would not change the selected cells; try a new seed or a wider selection.",
      };
    }
    return { intent, scope, changes, beforeHits, afterHits, error: null };
  }, [selectedStepText, selectedStepScope, selectedDrumTrack, pattern, seed, amount, bars, target, style]);
  const selectedNoteVariation = useMemo(
    () => (selectedNoteScope ? humanizeNoteSelection(pattern, selectedNoteScope, seed, amount) : null),
    [pattern, selectedNoteScope, seed, amount],
  );
  const selectedNoteChanges = useMemo(() => {
    if (!selectedNoteScope || !selectedNoteVariation) return [];
    return selectedNoteScope.flatMap((scope) => {
      const selectedIds = new Set(scope.noteIds);
      const before = pattern.notes[scope.trackId] ?? [];
      const afterById = new Map((selectedNoteVariation.notes[scope.trackId] ?? []).map((note) => [note.id, note]));
      return before
        .filter((note) => selectedIds.has(note.id))
        .map((note) => ({ before: note, after: afterById.get(note.id) ?? note }));
    });
  }, [pattern, selectedNoteScope, selectedNoteVariation]);
  const selectedPreviewPad = selectedStepScope
    ? selectedDrumTrack?.pads.find((pad) => pad.id === selectedStepScope.padIds[0])
    : undefined;
  const selectedPreviewRow = selectedPreviewPad ? (selectedVariationPattern?.rows[selectedPreviewPad.id] ?? []) : [];
  const selectedPreviewFrom = selectedStepScope
    ? Math.max(0, Math.min(pattern.stepCount - 1, Math.floor(Math.min(selectedStepScope.from, selectedStepScope.to))))
    : 0;
  const selectedPreviewTo = selectedStepScope
    ? Math.max(0, Math.min(pattern.stepCount - 1, Math.floor(Math.max(selectedStepScope.from, selectedStepScope.to))))
    : 0;
  const selectedPreviewBarStart = Math.floor(selectedPreviewFrom / 16) * 16;
  const selectedPreviewHitCount = selectedVariationPattern
    ? Object.values(selectedVariationPattern.rows).reduce(
        (total, row) => total + row.filter((velocity) => velocity > 0).length,
        0,
      )
    : 0;
  const beforeHits = Object.values(pattern.rows).reduce(
    (total, row) => total + row.filter((value) => value > 0).length,
    0,
  );
  const afterHits = Object.values(previewPatch.rows).reduce(
    (total, row) => total + row.filter((value) => value > 0).length,
    0,
  );

  const applySelectedVariation = () => {
    if (!selectedStepScope || !selectedDrumTrack || !selectedVariationPattern) return;
    const currentDoc = services.store.getDoc();
    const currentPattern = currentDoc.patterns.find((candidate) => candidate.id === pattern.id);
    const currentTrack = currentDoc.tracks.find((track) => track.kind === "drum" && track.id === selectedDrumTrack.id);
    const currentSelection = selectionStore.getState().stepSelection;
    const sameSelection = Boolean(
      currentSelection &&
      currentSelection.from === selectedStepScope.from &&
      currentSelection.to === selectedStepScope.to &&
      currentSelection.padIds.length === selectedStepScope.padIds.length &&
      currentSelection.padIds.every((padId, index) => padId === selectedStepScope.padIds[index]),
    );
    if (currentPattern !== pattern || currentTrack !== selectedDrumTrack || !sameSelection) {
      setFlash("Pattern or step selection changed — review the selected-step preview before applying.");
      return;
    }
    apply(`Varied selected steps · ${seed}`, () =>
      services.store.execute(
        assistVarySelectionCommand(currentDoc, pattern.id, selectedDrumTrack.id, selectedStepScope, seed, amount),
      ),
    );
  };

  const applySelectedStepInstruction = () => {
    const plan = selectedStepInstructionPlan;
    if (!plan.intent || !plan.scope || plan.error || !selectedStepScope || !selectedDrumTrack) return;
    const currentDoc = services.store.getDoc();
    const currentPattern = currentDoc.patterns.find((candidate) => candidate.id === pattern.id);
    const currentTrack = currentDoc.tracks.find((track) => track.kind === "drum" && track.id === selectedDrumTrack.id);
    const currentSelection = selectionStore.getState().stepSelection;
    const sameSelection = Boolean(
      currentSelection &&
      currentSelection.from === selectedStepScope.from &&
      currentSelection.to === selectedStepScope.to &&
      currentSelection.padIds.length === selectedStepScope.padIds.length &&
      currentSelection.padIds.every((padId, index) => padId === selectedStepScope.padIds[index]),
    );
    const currentIntent = parseSelectedStepIntent(selectedStepText);
    if (
      currentPattern !== pattern ||
      currentDoc.activePatternId !== pattern.id ||
      currentTrack !== selectedDrumTrack ||
      !sameSelection ||
      currentIntent?.operation !== plan.intent.operation ||
      currentIntent?.target !== plan.intent.target
    ) {
      setFlash("Pattern, step selection, or instruction changed — review the scoped preview before applying.");
      return;
    }

    try {
      const command =
        plan.intent.operation === "thin"
          ? assistThinSelectionCommand(currentDoc, pattern.id, selectedDrumTrack.id, plan.scope)
          : assistVarySelectionCommand(currentDoc, pattern.id, selectedDrumTrack.id, plan.scope, seed, amount);
      const targetLabel = plan.scope.padIds
        .map((padId) => selectedDrumTrack.pads.find((pad) => pad.id === padId)?.name)
        .filter((name): name is string => Boolean(name))
        .join(" + ");
      apply(`${plan.intent.operation === "thin" ? "Thinned" : "Humanized"} ${targetLabel} · ${seed}`, () =>
        services.store.execute(command),
      );
    } catch (error) {
      setFlash(error instanceof Error ? error.message : String(error));
    }
  };

  const applySelectedNoteVariation = () => {
    if (!selectedNoteScope || !selectedNoteVariation) return;
    const currentDoc = services.store.getDoc();
    const currentPattern = currentDoc.patterns.find((candidate) => candidate.id === pattern.id);
    const currentSelection = selectionStore.getState().noteSelections;
    const sameSelection =
      currentSelection.length === selection.noteSelections.length &&
      currentSelection.every((current, index) => {
        const expected = selection.noteSelections[index];
        return (
          expected !== undefined &&
          current.trackId === expected.trackId &&
          current.noteIds.length === expected.noteIds.length &&
          current.noteIds.every((noteId, noteIndex) => noteId === expected.noteIds[noteIndex])
        );
      });
    if (currentPattern !== pattern || !sameSelection) {
      setFlash("Pattern or note selection changed — review the selected-note preview before applying.");
      return;
    }
    try {
      const command = assistVaryNoteSelectionCommand(currentDoc, pattern.id, selectedNoteScope, seed, amount);
      apply(`Humanized ${selectedNoteChanges.length} selected notes · ${seed}`, () => services.store.execute(command));
    } catch (error) {
      setFlash(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="collab-panel assist-panel" role="dialog" aria-label="Pattern assist">
      <div className="collab-title">
        ASSIST — {pattern.name.toUpperCase()}
        <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close assist">
          ×
        </button>
      </div>
      <p className="collab-hint">
        Iterate on this pattern — your hits stay yours, the assist modifies surgically. Same seed = same result; the
        seed re-rolls after every apply. Ctrl+Z takes anything back.
      </p>

      <div className="assist-seed">
        <label className="collab-field">
          <span>SEED</span>
          <input value={seed} onChange={(e) => setSeed(e.target.value)} spellCheck={false} />
        </label>
        <button
          type="button"
          className="btn btn-small"
          title="Re-roll seed"
          onClick={() => setSeed((prev) => randomSeed(prev))}
        >
          ⚄
        </button>
      </div>

      <div className="assist-preview">
        <div className="assist-preview-header">
          <span>PREVIEW</span>
          <span className="assist-engine">LOCAL ASSIST {ASSIST_ENGINE_VERSION}</span>
          <select value={previewOperation} onChange={(e) => setPreviewOperation(e.target.value as AssistOperation)}>
            <option value="vary">VARY</option>
            <option value="build">BUILD</option>
            <option value="replace">REPLACE</option>
            <option value="fill">FILL</option>
          </select>
        </div>
        <div className="assist-preview-meta">
          {previewPad?.name ?? "No drum pad"} · {beforeHits} → {afterHits} hits ·{" "}
          {previewPatch.stepCount ?? pattern.stepCount} steps
        </div>
        <div className="assist-preview-grid" role="img" aria-label={`${previewOperation} pattern preview`}>
          {Array.from({ length: 16 }, (_, step) => (
            <span
              key={step}
              className={`assist-preview-cell${(previewRow[step] ?? 0) > 0 ? " active" : ""}${step % 4 === 0 ? " beat" : ""}`}
              style={(previewRow[step] ?? 0) > 0 ? { opacity: 0.3 + (previewRow[step] ?? 0) * 0.7 } : undefined}
            />
          ))}
        </div>
      </div>

      {stepSelection && !selectedStepScope && (
        <div className="collab-hint" role="alert">
          The step selection no longer matches this pattern or its drum track. Reselect steps before using a scoped
          assist.
        </div>
      )}

      {selection.noteSelections.length > 0 && !selectedNoteScope && (
        <div className="collab-hint" role="alert">
          The note selection no longer matches this pattern or its tracks. Reselect notes before using a scoped assist.
        </div>
      )}

      {selectedNoteScope && selectedNoteVariation && (
        <div className="assist-preview" aria-label="Selected note assist preview">
          <div className="assist-preview-header">
            <span>SELECTED NOTES · HUMANIZE</span>
            <span className="assist-engine">SCOPE LOCKED</span>
          </div>
          <div className="assist-preview-meta">
            {selectedNoteChanges.length} notes ·{" "}
            {[...new Set(selectedNoteScope.map((scope) => tracks.find((track) => track.id === scope.trackId)?.name))]
              .filter((name): name is string => Boolean(name))
              .join(" + ")}{" "}
            · timing ±{Math.round(10 * amount)} ticks · velocity ±{Math.round(12 * amount)}%
          </div>
          <div className="collab-hint" role="list" aria-label="Selected note changes preview">
            {selectedNoteChanges.slice(0, 6).map(({ before, after }) => (
              <div key={before.id} role="listitem">
                MIDI {before.pitch}: tick {before.start} → {after.start}, velocity {Math.round(before.velocity * 127)} →{" "}
                {Math.round(after.velocity * 127)}
              </div>
            ))}
            {selectedNoteChanges.length > 6 && <div>+ {selectedNoteChanges.length - 6} more selected notes</div>}
          </div>
          <button type="button" className="btn btn-export" onClick={applySelectedNoteVariation}>
            VARY SELECTED NOTES
          </button>
        </div>
      )}

      {selectedStepScope && selectedDrumTrack && selectedVariationPattern && (
        <div className="assist-preview" aria-label="Selected step range assist preview">
          <div className="assist-preview-header">
            <span>SELECTED CELLS · VARY</span>
            <span className="assist-engine">SCOPE LOCKED</span>
          </div>
          <div className="assist-preview-meta">
            {selectedDrumTrack.name} · {selectedPreviewPad?.name ?? "selected pad"} · bar{" "}
            {Math.floor(selectedPreviewFrom / 16) + 1}, steps {selectedPreviewFrom + 1}–{selectedPreviewTo + 1} ·{" "}
            {beforeHits} → {selectedPreviewHitCount} hits
          </div>
          <div className="assist-preview-grid" role="img" aria-label="vary selected steps preview">
            {Array.from({ length: 16 }, (_, step) => {
              const absoluteStep = selectedPreviewBarStart + step;
              const selected = absoluteStep >= selectedPreviewFrom && absoluteStep <= selectedPreviewTo;
              return (
                <span
                  key={step}
                  className={`assist-preview-cell${(selectedPreviewRow[absoluteStep] ?? 0) > 0 ? " active" : ""}${step % 4 === 0 ? " beat" : ""}${selected ? " selected" : ""}`}
                  style={
                    (selectedPreviewRow[absoluteStep] ?? 0) > 0
                      ? { opacity: 0.3 + selectedPreviewRow[absoluteStep]! * 0.7 }
                      : undefined
                  }
                />
              );
            })}
          </div>
          <label className="collab-field">
            <span>PRODUCER EDIT · DESCRIBE ONE CHANGE TO THESE CELLS</span>
            <input
              className="preset-save-input"
              value={selectedStepText}
              placeholder="make selected hats sparser"
              aria-label="Producer selected-step instruction"
              spellCheck={false}
              onChange={(event) => setSelectedStepText(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  selectedStepInstructionPlan.intent &&
                  selectedStepInstructionPlan.scope &&
                  !selectedStepInstructionPlan.error
                ) {
                  event.preventDefault();
                  applySelectedStepInstruction();
                }
              }}
            />
          </label>
          {selectedStepText.trim() &&
            (selectedStepInstructionPlan.error ? (
              <div className="collab-hint" role="alert">
                {selectedStepInstructionPlan.error}
              </div>
            ) : (
              <div className="collab-hint" role="region" aria-label="Producer step edit preview">
                <strong>
                  {selectedStepInstructionPlan.intent?.operation.toUpperCase()} ·{" "}
                  {selectedStepInstructionPlan.changes.length} cell changes · {selectedStepInstructionPlan.beforeHits} →{" "}
                  {selectedStepInstructionPlan.afterHits} hits
                </strong>
                {selectedStepInstructionPlan.changes.slice(0, 6).map((change) => (
                  <div key={`${change.padId}-${change.step}`}>
                    Step {change.step + 1} · {change.padName} · {Math.round(change.before * 100)}% →{" "}
                    {Math.round(change.after * 100)}%
                  </div>
                ))}
                {selectedStepInstructionPlan.changes.length > 6 && (
                  <div>+ {selectedStepInstructionPlan.changes.length - 6} more cell changes</div>
                )}
              </div>
            ))}
          <button
            type="button"
            className="btn btn-export"
            disabled={
              !selectedStepInstructionPlan.intent ||
              !selectedStepInstructionPlan.scope ||
              !!selectedStepInstructionPlan.error
            }
            onClick={applySelectedStepInstruction}
          >
            APPLY PRODUCER STEP EDIT · ONE UNDO STEP
          </button>
          <button type="button" className="btn btn-export" onClick={applySelectedVariation}>
            VARY SELECTED STEPS
          </button>
        </div>
      )}

      {scenes.length > 0 && (
        <div className="assist-arrange" role="group" aria-label="Arrange by words">
          <div className="assist-preview-header">
            <span>ARRANGE — describe the change</span>
            <span className="assist-engine">ARRANGE-1 · EN/SK</span>
          </div>
          <input
            className="preset-save-input"
            value={arrangeText}
            placeholder="e.g. shorten the intro to 2 bars, add a break before the drop"
            aria-label="Arrange the beat with words"
            spellCheck={false}
            onChange={(e) => setArrangeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && arrangeParsed && arrangeParsed.ops.length > 0) {
                const label = `Arranged (${arrangeParsed.ops.length} op)`;
                services.store.execute(applyArrangeOps(doc, arrangeParsed.ops));
                setArrangeApplied(label);
                setArrangeText("");
              }
            }}
          />
          {arrangeParsed && arrangeParsed.unrecognized.length > 0 && (
            <div className="collab-hint" role="alert">
              didn't understand: {arrangeParsed.unrecognized.join(" · ")}
            </div>
          )}
          {arrangeParsed && arrangeParsed.ops.length > 0 && (
            <div className="collab-hint">
              {arrangeParsed.ops
                .map((o) =>
                  o.op === "resize"
                    ? `resize → ${o.bars} bars`
                    : o.op === "addRole"
                      ? `add ${o.role} section`
                      : o.op === "remove"
                        ? `remove section`
                        : o.op === "duplicate"
                          ? `duplicate section`
                          : o.op === "reorder"
                            ? `move ${o.dir}`
                            : `auto-arrange song`,
                )
                .join(" · ")}{" "}
              — Enter applies as one undo step
            </div>
          )}
          {arrangeApplied && <div className="slice-info">{arrangeApplied}</div>}
        </div>
      )}

      <div className="assist-ops">
        <div className="assist-op">
          <label className="collab-field">
            <span>VARY — humanize velocities, ghosts, feel (amount {amount.toFixed(2)})</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="btn btn-export"
            onClick={() => apply("Varied", () => services.store.execute(assistVary(doc, pattern.id, seed, amount)))}
          >
            VARY PATTERN
          </button>
        </div>

        <div className="assist-op">
          <label className="collab-field">
            <span>BUILD — expand to bars with an element + energy ramp</span>
            <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
              <option value={2}>2 bars</option>
              <option value={4}>4 bars</option>
              <option value={8}>8 bars</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-export"
            onClick={() =>
              apply(`Built to ${bars} bars`, () => services.store.execute(assistBuild(doc, pattern.id, bars, seed)))
            }
          >
            BUILD
          </button>
        </div>

        <div className="assist-op">
          <div className="assist-op-row">
            <label className="collab-field">
              <span>REPLACE</span>
              <select
                value={target}
                onChange={(e) => {
                  const next = e.target.value as ReplaceTarget;
                  setTarget(next);
                  setStyle(styleNames(next)[0]);
                }}
              >
                <option value="hats">hi-hats</option>
                <option value="kicks">kicks</option>
                <option value="snares">snares</option>
              </select>
            </label>
            <label className="collab-field">
              <span>WITH STYLE</span>
              <select value={style} onChange={(e) => setStyle(e.target.value)}>
                {stylesForTarget.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="btn btn-export"
            onClick={() =>
              apply(`${target} → ${style}`, () =>
                services.store.execute(assistReplace(doc, pattern.id, target, style, seed)),
              )
            }
          >
            REPLACE
          </button>
        </div>

        <div className="assist-op">
          <button
            type="button"
            className="btn btn-export"
            onClick={() => apply("Fill added", () => services.store.execute(assistFill(doc, pattern.id, seed)))}
          >
            FILL LAST BAR (crescendo)
          </button>
        </div>
      </div>
      {flash && <div className="slice-info">{flash}</div>}
    </div>
  );
}
