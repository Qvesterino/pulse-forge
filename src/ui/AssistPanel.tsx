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
import { assistVarySelectionCommand } from "../commands/assistSelectionCommands";
import { applyAssistPatchToStepSelection, styleNames, type ReplaceTarget } from "../assist/patternOps";
import { buildAssistPatch } from "../assist/pipeline";
import { ASSIST_ENGINE_VERSION, type AssistOperation } from "../assist/types";
import { getActivePattern, getDrumTrack } from "../project-model/types";
import { nextSeed } from "../shared/dice";
import { applyArrangeOps, parseArrangeIntent, type ParsedArrange } from "../intent/arrangeWords";

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
  const drumTrack = drumTracks[0] ?? getDrumTrack(doc);
  const drumPads = drumTrack.pads;
  const [seed, setSeed] = useState(randomSeed);
  const [amount, setAmount] = useState(0.6);
  const [bars, setBars] = useState(4);
  const [target, setTarget] = useState<ReplaceTarget>("hats");
  const [style, setStyle] = useState("house");
  const [previewOperation, setPreviewOperation] = useState<AssistOperation>("vary");
  const [flash, setFlash] = useState<string | null>(null);
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
