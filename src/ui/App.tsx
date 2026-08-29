import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Services } from "../services";
import { SelectionStore } from "../store/SelectionStore";
import { ToolStore } from "../store/ToolStore";
import { SelectionContext, ServicesContext, ToolContext } from "./context";
import { ContextMenu, deriveContext, type ContextMenuState } from "./ContextMenu";
import { TopBar } from "./TopBar";
import { TrackTabs } from "./TrackTabs";
import { RackStrip } from "./RackStrip";
import { Sequencer } from "./Sequencer";
import { AudioUnlock } from "./AudioUnlock";
import type { StepSelection } from "./Sequencer";
import { Inspector } from "./Inspector";
import { Diagnostics } from "./Diagnostics";
import { PatternBar } from "./PatternBar";
import { Mixer } from "./Mixer";
import { EffectRack } from "./EffectRack";
import { ArrangementPanel } from "./ArrangementPanel";
import { ModPanel } from "./ModPanel";
import { MidiPanel } from "./MidiPanel";
import { ExportPanel } from "./ExportPanel";
import { UndoHistoryPanel } from "./UndoHistoryPanel";
import { InstallPrompt } from "./InstallPrompt";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  clearSteps,
  consolidateTimeRange,
  deleteArrangementClip,
  deleteNote,
  deleteNotes,
  duplicatePattern,
  duplicateTimeRange,
  setActivePattern,
  setTrackParams,
} from "../commands/commands";
import type { PatternClipboard } from "../commands/commands";
import type { SelectedNote } from "./PianoRoll";
import { matchShortcut, panelIdOfShortcut } from "./shortcuts";
import { BAR_TICKS, STEP_TICKS } from "../project-model/types";
import { CommandToast } from "./CommandToast";
import { HelpOverlay } from "./HelpOverlay";
import { OnboardingHint } from "./OnboardingHint";

const PANEL_KEYS = ["mixer", "fx", "arr", "mod", "exp", "midi"] as const;
type BottomPanel = (typeof PANEL_KEYS)[number];

export function App({
  services,
  onOpenBrowser,
  onReplaceServices,
}: {
  services: Services;
  onOpenBrowser: () => void;
  onReplaceServices: (services: Services) => void;
}) {
  const doc = useSyncExternalStore(services.store.subscribe, services.store.getDoc, services.store.getDoc);
  const playMode = useSyncExternalStore(
    services.playback.subscribe,
    services.playback.getSnapshot,
    services.playback.getSnapshot,
  );
  const [selectionStore] = useState(() => new SelectionStore());
  const selection = useSyncExternalStore(selectionStore.subscribe, selectionStore.getState, selectionStore.getState);
  const [toolStore] = useState(() => new ToolStore());
  const tool = useSyncExternalStore(toolStore.subscribe, toolStore.getTool, toolStore.getTool);
  void tool;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectedTrackId = selection.trackIds[0] ?? doc.tracks[0]?.id ?? "";
  const [selectedPadId, setSelectedPadId] = useState(
    doc.tracks[0]?.kind === "drum" ? (doc.tracks[0].pads[0]?.id ?? "") : "",
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [bottomPanel, setBottomPanel] = useState<BottomPanel | null>("mixer");
  const [clip, setClip] = useState<PatternClipboard | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [scaleSnap, setScaleSnap] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Derived unified selections
  const selectedNote = selection.noteSelections[0] ?? null;
  const stepSelection = selection.stepSelection;
  const setSelectedNote = (note: SelectedNote | null) => {
    if (!note) selectionStore.clearNotes();
    else selectionStore.setNotes(note, "replace");
  };
  const setStepSelection = (sel: StepSelection | null) => selectionStore.setStepSelection(sel);

  const track = doc.tracks.find((t) => t.id === selectedTrackId) ?? doc.tracks[0];
  const padId =
    track.kind === "drum" && track.pads.some((p) => p.id === selectedPadId)
      ? selectedPadId
      : track.kind === "drum"
        ? (track.pads[0]?.id ?? "")
        : "";

  const selectTrack = (trackId: string, e?: React.MouseEvent | KeyboardEvent) => {
    const mode =
      (e as unknown as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean })?.ctrlKey ||
      (e as unknown as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean })?.metaKey
        ? "add"
        : (e as unknown as { shiftKey?: boolean })?.shiftKey
          ? "range"
          : "replace";
    selectionStore.setTracks(
      [trackId],
      mode as "replace" | "add" | "range",
      doc.tracks.map((t) => t.id),
    );
    selectionStore.clearNotes();
    selectionStore.setStepSelection(null);
    selectionStore.clearTimeRange();
    const next = doc.tracks.find((t) => t.id === trackId);
    if (next?.kind === "drum") setSelectedPadId(next.pads[0]?.id ?? "");
  };

  const setBottomPanelTab = (panel: BottomPanel) => setBottomPanel((current) => (current === panel ? null : panel));

  // Init selection with first track if empty; clear step selection on pattern change
  useEffect(() => {
    if (selection.trackIds.length === 0 && doc.tracks[0]) {
      selectionStore.setTracks([doc.tracks[0].id], "replace");
    }
  }, [doc.tracks, selection.trackIds.length, selectionStore]);
  useEffect(() => {
    selectionStore.setStepSelection(null);
  }, [doc.activePatternId]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Another window-level listener already consumed this event (e.g. a
      // dialog closing itself on Escape) — never double-act on it.
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      // Escape is contextual: close menu/help → clear unified selection → reset tool → blur inputs
      if (event.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
          event.preventDefault();
          return;
        }
        if (helpOpen) {
          setHelpOpen(false);
          event.preventDefault();
          return;
        }
        if (
          selection.noteSelections.length > 0 ||
          selection.stepSelection ||
          selection.timeRange ||
          selection.clipIds.length > 0 ||
          selection.trackIds.length > 1
        ) {
          selectionStore.clear();
          toolStore.setTool("select");
          event.preventDefault();
          return;
        }
        if (tool !== "select") {
          toolStore.setTool("select");
          event.preventDefault();
          return;
        }
        if (typing) {
          target.blur();
          event.preventDefault();
          return;
        }
      }
      if (typing) return;

      // Tool switching: S/C/B/E/M without modifiers, Esc handled above already resets tool
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const lower = event.key.toLowerCase();
        const toolMap: Record<string, import("../store/ToolStore").Tool> = {
          s: "select",
          p: "pencil",
          c: "cut",
          b: "slip",
          e: "stretch",
          m: "mute",
        };
        const t = toolMap[lower];
        if (t) {
          event.preventDefault();
          toolStore.setTool(t);
          return;
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        if (track.kind === "instrument") {
          const pattern = doc.patterns.find((candidate) => candidate.id === doc.activePatternId);
          const notes = pattern?.notes?.[track.id] ?? [];
          setSelectedNote(notes.length > 0 ? { trackId: track.id, noteIds: notes.map((note) => note.id) } : null);
          event.preventDefault();
        }
        return;
      }

      // Consolidate zone: Ctrl+Shift+C (or Cmd+Shift+C) — guard: needs timeRange
      if (
        selection.timeRange &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        try {
          services.store.execute(consolidateTimeRange(doc, selection.timeRange.fromTick, selection.timeRange.toTick));
        } catch {
          // ignore empty zone
        }
        return;
      }

      const matched = matchShortcut(event);
      if (!matched) return;

      switch (matched) {
        case "playPause":
          event.preventDefault();
          services.playback.playPause();
          return;
        case "stop":
          event.preventDefault();
          services.playback.stop();
          return;
        case "seekHome":
          event.preventDefault();
          services.playback.seek(0);
          return;
        case "seekBack":
          event.preventDefault();
          services.playback.seek(Math.max(0, services.transport.position - BAR_TICKS));
          return;
        case "seekForward":
          event.preventDefault();
          services.playback.seek(services.transport.position + BAR_TICKS);
          return;
        case "save":
          event.preventDefault();
          void services.flushSave();
          return;
        case "undo":
          event.preventDefault();
          services.store.undo();
          return;
        case "redo":
          event.preventDefault();
          services.store.redo();
          return;
        case "nextTrack": {
          event.preventDefault();
          const idx = doc.tracks.findIndex((t) => t.id === track.id);
          const next = doc.tracks[(idx + 1) % doc.tracks.length];
          if (next) selectTrack(next.id);
          return;
        }
        case "prevTrack": {
          event.preventDefault();
          const idx = doc.tracks.findIndex((t) => t.id === track.id);
          const next = doc.tracks[(idx - 1 + doc.tracks.length) % doc.tracks.length];
          if (next) selectTrack(next.id);
          return;
        }
        case "selectTrack1":
        case "selectTrack2":
        case "selectTrack3":
        case "selectTrack4":
        case "selectTrack5":
        case "selectTrack6":
        case "selectTrack7":
        case "selectTrack8":
        case "selectTrack9": {
          event.preventDefault();
          const n = Number(matched.slice(-1)) - 1;
          const next = doc.tracks[n];
          if (next) selectTrack(next.id);
          return;
        }
        case "toggleMuteTrack":
          event.preventDefault();
          services.store.execute(setTrackParams(doc, track.id, { mute: !track.mute }));
          return;
        case "toggleSoloTrack":
          event.preventDefault();
          services.store.execute(setTrackParams(doc, track.id, { solo: !track.solo }));
          return;
        case "panelMix":
        case "panelFx":
        case "panelArr":
        case "panelMod":
        case "panelExport": {
          event.preventDefault();
          const panel = panelIdOfShortcut(matched);
          if (panel) setBottomPanelTab(panel as BottomPanel);
          return;
        }
        case "nextPattern": {
          event.preventDefault();
          const idx = doc.patterns.findIndex((p) => p.id === doc.activePatternId);
          const next = doc.patterns[(idx + 1) % doc.patterns.length];
          if (next) services.store.execute(setActivePattern(doc, next.id));
          return;
        }
        case "prevPattern": {
          event.preventDefault();
          const idx = doc.patterns.findIndex((p) => p.id === doc.activePatternId);
          const next = doc.patterns[(idx - 1 + doc.patterns.length) % doc.patterns.length];
          if (next) services.store.execute(setActivePattern(doc, next.id));
          return;
        }
        case "duplicatePattern": {
          event.preventDefault();
          if (selection.timeRange) {
            try {
              services.store.execute(duplicateTimeRange(doc, selection.timeRange.fromTick, selection.timeRange.toTick));
            } catch (e) {
              // fall back to pattern duplicate if zone empty
              services.store.execute(duplicatePattern(doc, doc.activePatternId));
            }
          } else {
            services.store.execute(duplicatePattern(doc, doc.activePatternId));
          }
          return;
        }
        case "deleteNote":
          if (selectedNote) {
            event.preventDefault();
            services.store.execute(
              selectedNote.noteIds.length === 1
                ? deleteNote(doc, selectedNote.trackId, selectedNote.noteIds[0])
                : deleteNotes(doc, selectedNote.trackId, selectedNote.noteIds),
            );
            setSelectedNote(null);
          } else if (stepSelection) {
            event.preventDefault();
            services.store.execute(
              clearSteps(doc, doc.activePatternId, stepSelection.padIds, stepSelection.from, stepSelection.to),
            );
            setStepSelection(null);
          } else if (selection.timeRange) {
            event.preventDefault();
            const from = selection.timeRange.fromTick;
            const to = selection.timeRange.toTick;
            let newDoc = doc;
            const oldDoc = doc;
            // Clips overlapping timeRange
            const clipsToDelete = newDoc.arrangement.clips.filter((c) => {
              const cFrom = c.startBar * BAR_TICKS;
              const cTo = (c.startBar + c.lengthBars) * BAR_TICKS;
              return cFrom < to && cTo > from;
            });
            for (const c of clipsToDelete) {
              newDoc = deleteArrangementClip(newDoc, c.id).execute(newDoc);
            }
            // Notes and steps in active pattern within timeRange
            const pattern = newDoc.patterns.find((p) => p.id === newDoc.activePatternId);
            if (pattern) {
              for (const trackId of Object.keys(pattern.notes)) {
                const notes = pattern.notes[trackId] ?? [];
                const toDelete = notes.filter((n) => n.start >= from && n.start < to).map((n) => n.id);
                if (toDelete.length > 0) {
                  newDoc = deleteNotes(newDoc, trackId, toDelete).execute(newDoc);
                }
              }
              const fromStep = Math.max(0, Math.floor(from / STEP_TICKS));
              const toStep = Math.min(pattern.stepCount - 1, Math.ceil(to / STEP_TICKS) - 1);
              if (fromStep <= toStep) {
                for (const track of newDoc.tracks) {
                  if (track.kind !== "drum") continue;
                  for (const pad of track.pads) {
                    const row = pattern.rows[pad.id];
                    if (!row) continue;
                    let has = false;
                    for (let s = fromStep; s <= toStep && s < row.length; s++) {
                      if (row[s] > 0) {
                        has = true;
                        break;
                      }
                    }
                    if (has) newDoc = clearSteps(newDoc, pattern.id, [pad.id], fromStep, toStep).execute(newDoc);
                  }
                }
              }
            }
            services.store.execute({
              type: "deleteTimeRange",
              label: "Delete time range",
              execute: () => newDoc,
              undo: () => oldDoc,
            } as unknown as import("../commands/types").Command);
            selectionStore.clear();
          } else if (selection.clipIds.length > 0) {
            event.preventDefault();
            let newDoc = doc;
            const oldDoc = doc;
            for (const clipId of selection.clipIds) {
              newDoc = deleteArrangementClip(newDoc, clipId).execute(newDoc);
            }
            services.store.execute({
              type: "deleteClips",
              label: "Delete clips",
              execute: () => newDoc,
              undo: () => oldDoc,
            } as unknown as import("../commands/types").Command);
            selectionStore.clear();
          }
          return;
        case "toggleHelp":
          event.preventDefault();
          setHelpOpen((v) => !v);
          return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [services, doc, track, selection, helpOpen, selectionStore, tool, contextMenu, toolStore]);

  // Hold RMB 220ms → context menu, RMB drag >6px cancels hold (lets lasso handle it)
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2) return;
      holdStartRef.current = { x: e.clientX, y: e.clientY };
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = window.setTimeout(() => {
        if (!holdStartRef.current) return;
        const ctx = deriveContext(selection, null);
        setContextMenu({ x: holdStartRef.current.x, y: holdStartRef.current.y, context: ctx });
        holdStartRef.current = null;
      }, 220);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!holdStartRef.current) return;
      const dx = e.clientX - holdStartRef.current.x;
      const dy = e.clientY - holdStartRef.current.y;
      if (Math.hypot(dx, dy) > 6) {
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        holdStartRef.current = null;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 2) return;
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      holdStartRef.current = null;
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("contextmenu", onContextMenu);
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    };
  }, [selection]);

  return (
    <ServicesContext.Provider value={services}>
      <SelectionContext.Provider value={selectionStore}>
        <ToolContext.Provider value={toolStore}>
          <AudioUnlock />
          <div className="app">
            <TopBar
              diagnosticsOpen={diagnosticsOpen}
              bottomPanel={bottomPanel}
              playMode={playMode}
              onSetPlayMode={services.playback.setMode}
              onToggleDiagnostics={() => setDiagnosticsOpen((open) => !open)}
              onSetBottomPanel={setBottomPanelTab}
              onToggleHelp={() => setHelpOpen((v) => !v)}
              onOpenBrowser={onOpenBrowser}
              onReplaceServices={onReplaceServices}
              scaleSnap={scaleSnap}
              onToggleScaleSnap={() => setScaleSnap((s) => !s)}
              historyOpen={historyOpen}
              onToggleHistory={() => setHistoryOpen((v) => !v)}
            />
            <main className="workspace">
              <div className="workspace-main">
                <TrackTabs selectedTrackId={track.id} onSelectTrack={selectTrack} />
                {track.kind === "drum" && (
                  <RackStrip track={track} selectedPadId={padId} onSelectPad={setSelectedPadId} />
                )}
                <PatternBar clip={clip} onCopy={setClip} />
                <Sequencer
                  selectedPadId={padId}
                  selectedTrackId={track.id}
                  onSelectTrack={selectTrack}
                  onSelectPad={setSelectedPadId}
                  selectedNote={selectedNote}
                  onSelectNote={setSelectedNote}
                  stepSelection={stepSelection}
                  onSelectSteps={setStepSelection}
                  scaleSnap={scaleSnap}
                />
              </div>
              <Inspector track={track} selectedPadId={padId} />
            </main>
            <ErrorBoundary panel="mixer">{bottomPanel === "mixer" && <Mixer />}</ErrorBoundary>
            <ErrorBoundary panel="fx">{bottomPanel === "fx" && <EffectRack track={track} />}</ErrorBoundary>
            <ErrorBoundary panel="arr">{bottomPanel === "arr" && <ArrangementPanel />}</ErrorBoundary>
            <ErrorBoundary panel="mod">{bottomPanel === "mod" && <ModPanel />}</ErrorBoundary>
            <ErrorBoundary panel="exp">{bottomPanel === "exp" && <ExportPanel />}</ErrorBoundary>
            <ErrorBoundary panel="midi">
              {bottomPanel === "midi" && (
                <MidiPanel
                  selectedTrackId={track.id}
                  selectedNote={selectedNote}
                  scaleSnap={scaleSnap}
                  onToggleScaleSnap={() => setScaleSnap((value) => !value)}
                  onClearSelection={() => setSelectedNote(null)}
                />
              )}
            </ErrorBoundary>
            {diagnosticsOpen && (
              <ErrorBoundary panel="diagnostics">
                <Diagnostics />
              </ErrorBoundary>
            )}
            <footer className="statusbar">
              <span>
                SPACE play · 1–5 panels · ? help · Ctrl+Z undo · <kbd className="statusbar-kbd">1</kbd>–
                <kbd className="statusbar-kbd">9</kbd> tracks · TOOL {tool.toUpperCase()} (S/C/B/E/M)
              </span>
            </footer>
            <CommandToast />
            <UndoHistoryPanel open={historyOpen} />
            <InstallPrompt />
            <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
            <OnboardingHint />
            <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
          </div>
        </ToolContext.Provider>
      </SelectionContext.Provider>
    </ServicesContext.Provider>
  );
}
