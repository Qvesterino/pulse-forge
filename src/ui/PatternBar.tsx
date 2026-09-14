import { useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import {
  clearPattern,
  createFill,
  createPattern,
  deletePattern,
  duplicatePattern,
  mutatePattern,
  pastePattern,
  quantizePatternToGrid,
  quantizePatternToScale,
  renamePattern,
  renameScene,
  reorderPattern,
  setActivePattern,
  setGroove,
  setPatternLength,
} from "../commands/commands";
import type { PatternClipboard } from "../commands/commands";
import { grooveOf, GRID_8TH, GRID_16TH, GRID_32ND } from "../project-model/types";
import { DragNumber } from "./controls";
import { GenerateDialog } from "./GenerateDialog";
import { SceneLauncher } from "./SceneLauncher";
import { usePlayheadBar } from "./playhead";

/** Byte ceiling for .mid imports — mirrors MAX_PROJECT_IMPORT_BYTES. Kept
 * local (not in the lazy midi chunk) so checking it never pulls the chunk. */
const MAX_MIDI_IMPORT_BYTES = 10 * 1024 * 1024;

interface DragState {
  patternId: string;
  fromIndex: number;
  startX: number;
  currentX: number;
}

export function PatternBar({
  clip,
  onCopy,
  onOpenDice,
}: {
  clip: PatternClipboard | null;
  onCopy: (clip: PatternClipboard) => void;
  onOpenDice?: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const active = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const groove = grooveOf(doc);
  const playheadBar = usePlayheadBar(services.transport);
  const chipsRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const midiFileRef = useRef<HTMLInputElement | null>(null);
  const [midiStatus, setMidiStatus] = useState<string | null>(null);
  /** Parse a .mid file and drop it into the project as a new pattern. */
  const importMidiFile = async (file: File) => {
    try {
      setMidiStatus(null);
      // Same ceiling class as the project-import cap: a hostile/huge .mid
      // would otherwise buffer unbounded note arrays before validation
      // could clip them, and OOM the tab.
      if (file.size > MAX_MIDI_IMPORT_BYTES) {
        setMidiStatus(`Import failed: ${file.name} is too large (max ${MAX_MIDI_IMPORT_BYTES / (1024 * 1024)} MB)`);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // MIDI I/O is a lazy chunk — it only loads on first use.
      const { importMidiCommand } = await import("../midi/midiProject");
      const command = importMidiCommand(doc, bytes, file.name.replace(/\.[^.]+$/, ""));
      services.store.execute(command);
      const summary = (command as { summary?: { notes: number; drumHits: number; bpm: number | null } }).summary;
      setMidiStatus(
        summary
          ? `${file.name}: ${summary.notes} notes + ${summary.drumHits} drum hits${summary.bpm ? ` · ${summary.bpm} BPM` : ""}`
          : `${file.name} imported`,
      );
    } catch (error) {
      setMidiStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const beginRename = (id: string, name: string) => {
    setEditingId(id);
    setDraft(name);
  };

  const [quantizeGrid, setQuantizeGrid] = useState<number>(GRID_16TH);

  const commitRename = () => {
    if (editingId !== null && draft.trim() !== "") {
      const current = doc.patterns.find((p) => p.id === editingId);
      if (current && current.name !== draft.trim()) {
        services.store.execute(renamePattern(doc, editingId, draft.trim()));
      }
    }
    setEditingId(null);
  };

  const getDropIndex = (clientX: number): number => {
    const chips = chipsRef.current;
    if (!chips) return doc.patterns.length;
    const buttons = chips.querySelectorAll<HTMLButtonElement>(".pattern-chip");
    for (let i = 0; i < buttons.length; i++) {
      const rect = buttons[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) return i;
    }
    return doc.patterns.length;
  };

  const handlePointerDown = (event: React.PointerEvent, patternId: string, index: number) => {
    if (event.button !== 0 || editingId === patternId) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const state: DragState = { patternId, fromIndex: index, startX: event.clientX, currentX: event.clientX };
    dragRef.current = state;
    setDrag(state);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current.currentX = event.clientX;
    setDrag({ ...dragRef.current });
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { fromIndex, startX } = dragRef.current;
    const dx = Math.abs(event.clientX - startX);
    dragRef.current = null;
    setDrag(null);
    if (dx < 5) return; // was a click, not a drag
    const toIndex = getDropIndex(event.clientX);
    if (toIndex !== fromIndex) {
      services.store.execute(reorderPattern(doc, fromIndex, toIndex > fromIndex ? toIndex - 1 : toIndex));
    }
  };

  // Interrupted reorder drag — abort without reordering.
  const handlePointerCancel = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const dragToIndex = drag ? getDropIndex(drag.currentX) : -1;

  return (
    <section className="pattern-bar" aria-label="Patterns">
      <div className="pattern-chips" role="tablist" aria-label="Pattern selector" ref={chipsRef}>
        {doc.patterns.map((pattern, index) => {
          const isActive = pattern.id === doc.activePatternId;
          const isDragging = drag?.patternId === pattern.id;
          if (editingId === pattern.id) {
            return (
              <input
                key={pattern.id}
                className="pattern-rename"
                value={draft}
                autoFocus
                aria-label="Pattern name"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setEditingId(null);
                }}
              />
            );
          }
          return (
            <button
              key={pattern.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`pattern-chip${isActive ? " active" : ""}${isDragging ? " dragging" : ""}`}
              title={`${pattern.name} (${pattern.stepCount} steps) — click to select, double-click or F2 to rename, drag to reorder`}
              onClick={() => {
                if (!dragRef.current) services.store.execute(setActivePattern(doc, pattern.id));
              }}
              onDoubleClick={() => beginRename(pattern.id, pattern.name)}
              onPointerDown={(e) => handlePointerDown(e, pattern.id, index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onKeyDown={(event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  beginRename(pattern.id, pattern.name);
                }
              }}
            >
              {pattern.name}
            </button>
          );
        })}
        {drag && (
          <div
            className="pattern-drop-indicator"
            style={{
              left: (() => {
                const chips = chipsRef.current;
                if (!chips) return 0;
                const buttons = chips.querySelectorAll<HTMLButtonElement>(".pattern-chip");
                if (dragToIndex >= buttons.length) {
                  const last = buttons[buttons.length - 1];
                  return last ? last.getBoundingClientRect().right - chips.getBoundingClientRect().left : 0;
                }
                const target = buttons[dragToIndex];
                return target ? target.getBoundingClientRect().left - chips.getBoundingClientRect().left : 0;
              })(),
            }}
          />
        )}
      </div>

      <div className="pattern-groove" aria-label="Groove">
        <DragNumber
          label="SWING"
          value={groove.swing}
          min={0}
          max={1}
          defaultValue={0}
          sensitivity={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(swing) => services.store.execute(setGroove(doc, { swing }))}
        />
        <DragNumber
          label="HUM·T"
          value={groove.humanizeTiming}
          min={0}
          max={1}
          defaultValue={0}
          sensitivity={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(humanizeTiming) => services.store.execute(setGroove(doc, { humanizeTiming }))}
        />
        <DragNumber
          label="HUM·V"
          value={groove.humanizeVelocity}
          min={0}
          max={1}
          defaultValue={0}
          sensitivity={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(humanizeVelocity) => services.store.execute(setGroove(doc, { humanizeVelocity }))}
        />
      </div>

      <div className="pattern-actions">
        <button
          type="button"
          className="btn btn-small"
          title="New pattern"
          onClick={() => services.store.execute(createPattern(doc))}
        >
          ADD
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Duplicate active pattern (Ctrl+D)"
          onClick={() => services.store.execute(duplicatePattern(doc, doc.activePatternId))}
        >
          DUP
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Mutate active pattern into a seeded variation (velocities, ghosts, microtiming)"
          onClick={() => services.store.execute(mutatePattern(doc, doc.activePatternId))}
        >
          MUT
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Duplicate active pattern as a fill (snare roll over the last beat)"
          onClick={() => services.store.execute(createFill(doc, doc.activePatternId))}
        >
          FILL
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Generate a new pattern from genre groove (Markov chain)"
          onClick={() => setGenerateOpen(true)}
        >
          GEN
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Import a .mid file as a new pattern (drums via GM channel 10, rest as instrument tracks)"
          onClick={() => midiFileRef.current?.click()}
        >
          MIDI
        </button>
        <input
          ref={midiFileRef}
          type="file"
          accept=".mid,.midi,audio/midi,audio/x-midi"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void importMidiFile(file);
          }}
        />
        <button
          type="button"
          className="btn btn-small btn-dice"
          title="Open Dice — rapid beat generator (100 rolls)"
          onClick={() => onOpenDice?.()}
        >
          🎲 DICE
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Copy active pattern"
          onClick={() => onCopy({ stepCount: active.stepCount, rows: active.rows, notes: active.notes ?? {} })}
        >
          COPY
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Paste into active pattern"
          disabled={clip === null}
          onClick={() => clip && services.store.execute(pastePattern(doc, clip))}
        >
          PASTE
        </button>
        <button
          type="button"
          className="btn btn-small"
          title="Clear all steps of active pattern"
          onClick={() => services.store.execute(clearPattern(doc, doc.activePatternId))}
        >
          CLEAR
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          title="Delete active pattern"
          disabled={doc.patterns.length <= 1}
          onClick={() => services.store.execute(deletePattern(doc, doc.activePatternId))}
        >
          DEL
        </button>
        <select
          className="pattern-length"
          aria-label="Pattern length"
          title="Pattern length in steps"
          value={active.stepCount}
          onChange={(event) =>
            services.store.execute(setPatternLength(doc, doc.activePatternId, Number(event.target.value)))
          }
        >
          <option value={16}>16</option>
          <option value={32}>32</option>
          <option value={64}>64</option>
          <option value={128}>128</option>
          <option value={256}>256</option>
        </select>
        <select
          className="pattern-length"
          aria-label="Quantize grid"
          title="Quantize note positions to grid"
          value={quantizeGrid}
          onChange={(event) => {
            const gridTicks = Number(event.target.value);
            setQuantizeGrid(gridTicks);
            services.store.execute(quantizePatternToGrid(doc, doc.activePatternId, gridTicks));
          }}
        >
          <option value={GRID_8TH}>1/8</option>
          <option value={GRID_16TH}>1/16</option>
          <option value={GRID_32ND}>1/32</option>
        </select>
        {doc.key && (
          <button
            type="button"
            className="btn btn-small"
            title={`Snap all notes to the project scale (${doc.key})`}
            onClick={() => services.store.execute(quantizePatternToScale(doc, doc.activePatternId, doc.key!))}
          >
            SCALE
          </button>
        )}
      </div>

      {midiStatus && (
        <div className="pattern-midi-status" role="status" aria-label="MIDI import status">
          {midiStatus}
        </div>
      )}

      <SceneLauncher
        variant="bar"
        playheadBar={playheadBar}
        onRenameScene={(scene, name) => services.store.execute(renameScene(doc, scene.id, name))}
      />

      <GenerateDialog open={generateOpen} onClose={() => setGenerateOpen(false)} />
    </section>
  );
}
