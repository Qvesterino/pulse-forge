import { useEffect, useMemo, useRef, useState, useSyncExternalStore, lazy, Suspense } from "react";
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
import { OnboardingTour } from "./OnboardingTour";
import type { StepSelection } from "./Sequencer";
import { Inspector } from "./Inspector";
import { FloatingPlugin } from "./FloatingPlugin";
import { Diagnostics } from "./Diagnostics";
import { PatternBar } from "./PatternBar";
import { EffectRack } from "./EffectRack";
import { UndoHistoryPanel } from "./UndoHistoryPanel";
// Bottom dock panels load on first open — they are large and most sessions
// touch only one or two of them.
const Mixer = lazy(() => import("./Mixer").then((m) => ({ default: m.Mixer })));
const ArrangementPanel = lazy(() => import("./ArrangementPanel").then((m) => ({ default: m.ArrangementPanel })));
const ModPanel = lazy(() => import("./ModPanel").then((m) => ({ default: m.ModPanel })));
const MidiPanel = lazy(() => import("./MidiPanel").then((m) => ({ default: m.MidiPanel })));
const ExportPanel = lazy(() => import("./ExportPanel").then((m) => ({ default: m.ExportPanel })));
const DiceTray = lazy(() => import("./DiceTray").then((m) => ({ default: m.DiceTray })));
import { InstallPrompt } from "./InstallPrompt";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  addArrangementTransition,
  addAudioClip,
  clearSteps,
  consolidateTimeRange,
  deleteArrangementClip,
  deleteAudioClip,
  deleteNote,
  deleteNotes,
  duplicatePattern,
  duplicateTimeRange,
  setActivePattern,
  setTrackParams,
  splitAudioClipAtTick,
  updateAudioClip,
} from "../commands/commands";
import { detectTransientsAsync } from "../audio-workers/onset-detector-client";
import type { PatternClipboard } from "../commands/commands";
import type { SelectedNote } from "./PianoRoll";
import { matchShortcut, panelIdOfShortcut, type ShortcutKey } from "./shortcuts";
import type { PaletteDeps } from "./commandPalette";
import { BAR_TICKS, PPQ, STEP_TICKS } from "../project-model/types";
import { userSampleId } from "../persistence/UserSampleRepository";
import { buildBounceZoneDoc } from "../rendering/bounce";
import { renderProject } from "../rendering/renderer";
import { encodeWav } from "../rendering/wav";
import { CommandToast } from "./CommandToast";
// Palette lives in a lazy chunk — it loads on first Ctrl+K.
const PaletteOverlay = lazy(() => import("./PaletteOverlay").then((m) => ({ default: m.PaletteOverlay })));
import { HelpOverlay } from "./HelpOverlay";
import { OnboardingHint } from "./OnboardingHint";
import { DiceProvider } from "./DiceContext";

import { useDockLayout, toggleSlot, openInSlotA, clampDockHeight, type BottomPanel } from "./dockLayout";
import { isPadKey, padKeysArmed, setPadKeysArmed } from "./padKeys";

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
  // A services swap is a project switch (collab start/leave): selections hold
  // ids from the previous document and must not leak into the new one.
  useEffect(() => {
    selectionStore.clear();
  }, [services, selectionStore]);
  const [toolStore] = useState(() => new ToolStore());
  const tool = useSyncExternalStore(toolStore.subscribe, toolStore.getTool, toolStore.getTool);
  void tool;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartRef = useRef<{ x: number; y: number } | null>(null);
  const transientJumpRef = useRef(0);
  const transientJumpAbortRef = useRef<AbortController | null>(null);
  const selectedTrackId = selection.trackIds[0] ?? doc.tracks[0]?.id ?? "";
  const [selectedPadId, setSelectedPadId] = useState(
    doc.tracks[0]?.kind === "drum" ? (doc.tracks[0].pads[0]?.id ?? "") : "",
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const viewportMax = typeof window === "undefined" ? 800 : window.innerHeight * 0.7;
  const [dock, setDock] = useDockLayout(viewportMax);
  const bottomPanel = dock.slotA;
  const splitPanel = dock.slotB;
  const setBottomPanel = (panel: BottomPanel) => setDock(openInSlotA(dock, panel));
  const setBottomPanelTab = (panel: BottomPanel, split?: boolean) => setDock(toggleSlot(dock, panel, split ? 1 : 0));
  const startDockResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dock.height;
    const onMove = (move: PointerEvent) => {
      setDock({ ...dock, height: clampDockHeight(startHeight + (startY - move.clientY), viewportMax) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // Interrupted resize (touch takeover, …) — stop following the pointer.
    const onCancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const [clip, setClip] = useState<PatternClipboard | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scaleSnap, setScaleSnap] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pluginTrackId, setPluginTrackId] = useState<string | null>(null);
  // Mobile bottom-sheet: the bottom panel row collapses to a grab handle.
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const [bouncingRange, setBouncingRange] = useState(false);
  // Capture last take (Ableton) — offered after pause/stop when the ring has material
  const [captureOffer, setCaptureOffer] = useState(false);
  useEffect(() => {
    if (playMode !== "pattern" && playMode !== "song") return;
    // playing=false snapshot after pause/stop — offer capture if the ring holds events
    const snapshot = services.playback.getSnapshot();
    void snapshot;
    return;
  }, [services.playback, playMode]);
  useEffect(() => {
    // Watch capture snapshot: when transport paused and the ring holds events, show the offer
    const unsubscribe = services.capture.subscribe(() => {
      const snap = services.capture.getSnapshot();
      if (!snap.capturing && services.transport.playing === false && services.capture.hasCapturedMaterial) {
        setCaptureOffer(true);
      }
    });
    return unsubscribe;
  }, [services]);

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
    const trackObj = doc.tracks.find((t) => t.id === trackId);
    const ids =
      trackObj?.kind === "group"
        ? [trackId, ...doc.tracks.filter((t) => t.kind !== "group" && t.groupId === trackId).map((t) => t.id)]
        : [trackId];
    selectionStore.setTracks(
      ids,
      mode as "replace" | "add" | "range",
      doc.tracks.map((t) => t.id),
    );
    selectionStore.clearNotes();
    selectionStore.setStepSelection(null);
    selectionStore.clearTimeRange();
    const next = doc.tracks.find((t) => t.id === trackId);
    if (next?.kind === "drum") setSelectedPadId(next.pads[0]?.id ?? "");
  };

  // Init selection with first track if empty; clear step selection on pattern change
  useEffect(() => {
    if (selection.trackIds.length === 0 && doc.tracks[0]) {
      selectionStore.setTracks([doc.tracks[0].id], "replace");
    }
  }, [doc.tracks, selection.trackIds.length, selectionStore]);
  useEffect(() => {
    selectionStore.setStepSelection(null);
  }, [doc.activePatternId]);
  // Pad keys only shadow plain-letter shortcuts while the drum rack is
  // visible — selecting an instrument track restores S/P/C/B/E/M and P.
  useEffect(() => {
    setPadKeysArmed(doc.tracks.some((t) => t.id === selectedTrackId && t.kind === "drum"));
    return () => setPadKeysArmed(false);
  }, [doc.tracks, selectedTrackId]);

  // Shortcut action dispatch — shared by the keyboard handler and the
  // command palette so both always do the same thing.
  const runShortcutRef = useRef<(key: ShortcutKey, event?: { preventDefault(): void }) => void>(() => {});
  runShortcutRef.current = (matched: ShortcutKey, event?: { preventDefault(): void }) => {
    switch (matched) {
        case "playPause":
          event?.preventDefault();
          services.playback.playPause();
          return;
        case "stop":
          event?.preventDefault();
          services.playback.stop();
          return;
        case "seekHome":
          event?.preventDefault();
          services.playback.seek(0);
          return;
        case "seekBack":
          event?.preventDefault();
          services.playback.seek(Math.max(0, services.transport.position - BAR_TICKS));
          return;
        case "seekForward":
          event?.preventDefault();
          services.playback.seek(services.transport.position + BAR_TICKS);
          return;
        case "save":
          event?.preventDefault();
          void services.flushSave();
          return;
        case "undo":
          event?.preventDefault();
          services.store.undo();
          return;
        case "redo":
          event?.preventDefault();
          services.store.redo();
          return;
        case "nextTrack": {
          event?.preventDefault();
          const idx = doc.tracks.findIndex((t) => t.id === track.id);
          const next = doc.tracks[(idx + 1) % doc.tracks.length];
          if (next) selectTrack(next.id);
          return;
        }
        case "prevTrack": {
          event?.preventDefault();
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
          event?.preventDefault();
          const n = Number(matched.slice(-1)) - 1;
          const next = doc.tracks[n];
          if (next) selectTrack(next.id);
          return;
        }
        case "toggleMuteTrack":
          event?.preventDefault();
          services.store.execute(setTrackParams(doc, track.id, { mute: !track.mute }));
          return;
        case "toggleSoloTrack":
          event?.preventDefault();
          services.store.execute(setTrackParams(doc, track.id, { solo: !track.solo }));
          return;
        case "panelMix":
        case "panelFx":
        case "panelArr":
        case "panelMod":
        case "panelExport":
        case "panelDice": {
          event?.preventDefault();
          const panel = panelIdOfShortcut(matched);
          if (panel) setBottomPanelTab(panel as BottomPanel);
          return;
        }
        case "nextPattern": {
          event?.preventDefault();
          const idx = doc.patterns.findIndex((p) => p.id === doc.activePatternId);
          const next = doc.patterns[(idx + 1) % doc.patterns.length];
          if (next) services.store.execute(setActivePattern(doc, next.id));
          return;
        }
        case "prevPattern": {
          event?.preventDefault();
          const idx = doc.patterns.findIndex((p) => p.id === doc.activePatternId);
          const next = doc.patterns[(idx - 1 + doc.patterns.length) % doc.patterns.length];
          if (next) services.store.execute(setActivePattern(doc, next.id));
          return;
        }
        case "duplicatePattern": {
          event?.preventDefault();
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
            event?.preventDefault();
            services.store.execute(
              selectedNote.noteIds.length === 1
                ? deleteNote(doc, selectedNote.trackId, selectedNote.noteIds[0])
                : deleteNotes(doc, selectedNote.trackId, selectedNote.noteIds),
            );
            setSelectedNote(null);
          } else if (stepSelection) {
            event?.preventDefault();
            services.store.execute(
              clearSteps(doc, doc.activePatternId, stepSelection.padIds, stepSelection.from, stepSelection.to),
            );
            setStepSelection(null);
          } else if (selection.timeRange) {
            event?.preventDefault();
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
            event?.preventDefault();
            let newDoc = doc;
            const oldDoc = doc;
            // Same routing as the context menu's Delete: a clip selection can
            // mix arrangement clips and audio clips — delete both kinds in one
            // gesture.
            const arrangementIds = new Set(doc.arrangement.clips.map((c) => c.id));
            const audioIds = new Set((doc.arrangement.audioClips ?? []).map((c) => c.id));
            for (const clipId of selection.clipIds) {
              if (arrangementIds.has(clipId)) newDoc = deleteArrangementClip(newDoc, clipId).execute(newDoc);
              else if (audioIds.has(clipId)) newDoc = deleteAudioClip(newDoc, clipId).execute(newDoc);
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
          event?.preventDefault();
          setHelpOpen((v) => !v);
          return;
      }
  };

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
      // Pad keys (user-rebindable) shadow plain-letter shortcuts while the
      // drum rack is visible: pressing a bound key plays the pad instead of
      // triggering e.g. the loop toggle. With an instrument track selected
      // there is no rack to play, so S/P/C/B/E/M and P stay shortcuts.
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !typing &&
        padKeysArmed() &&
        isPadKey(event.key.toLowerCase())
      ) {
        return;
      }
      // Command palette (Ctrl/Cmd+K) — works while typing in inputs too.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Escape is contextual: close menu/help → clear unified selection → reset tool → blur inputs
      if (event.key === "Escape") {
        if (captureOffer) {
          setCaptureOffer(false);
          event.preventDefault();
          return;
        }
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

      // A = Capture last take (when the offer is showing) — Ableton-style
      if (
        captureOffer &&
        (event.key === "a" || event.key === "A") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const cmd = services.capture.captureLastTake();
        if (cmd) {
          try {
            services.store.execute(cmd);
          } catch {
            /* ignore */
          }
        }
        setCaptureOffer(false);
        return;
      }

      // Tab-to-Transient (PT/FL) — Tab / Shift+Tab jumps playhead to next/prev transient in selected audioClip
      if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const clips = doc.arrangement.audioClips ?? [];
        if (clips.length > 0) {
          const pos = services.transport.position;
          // Prefer clip under playhead, else nearest
          let target: (typeof clips)[number] | null = null;
          for (const c of clips) {
            const s = c.startBar * BAR_TICKS;
            const e = s + c.lengthBars * BAR_TICKS;
            if (pos >= s && pos < e) {
              target = c;
              break;
            }
          }
          if (!target) {
            // Find clip with start > pos (next) or previous
            const sorted = [...clips].sort((a, b) => a.startBar - b.startBar);
            if (!event.shiftKey) {
              target = sorted.find((c) => c.startBar * BAR_TICKS > pos) ?? sorted[0] ?? null;
            } else {
              const rev = [...sorted].reverse();
              target = rev.find((c) => c.startBar * BAR_TICKS < pos) ?? rev[0] ?? null;
            }
          }
          if (target) {
            const sourceTarget = target;
            const buf = services.bank.get(sourceTarget.bufferId);
            if (buf) {
              // Prevent browser focus navigation synchronously; detection may
              // be worker-backed and therefore completes after this handler.
              event.preventDefault();
              const backwards = event.shiftKey;
              transientJumpAbortRef.current?.abort();
              const controller = new AbortController();
              transientJumpAbortRef.current = controller;
              const request = ++transientJumpRef.current;
              void (async () => {
                const times = await detectTransientsAsync(buf.getChannelData(0), buf.sampleRate, 1, controller.signal);
                if (request !== transientJumpRef.current) return;
                // Do not apply a result to a clip that was deleted, moved to a
                // different asset, or replaced while analysis was running.
                const currentDoc = services.store.doc;
                const currentClips = currentDoc.arrangement.audioClips ?? [];
                const currentTarget = currentClips.find((clip) => clip.id === sourceTarget.id);
                if (
                  !currentTarget ||
                  currentTarget.bufferId !== sourceTarget.bufferId ||
                  services.bank.get(currentTarget.bufferId) !== buf
                )
                  return;
                const activePos = services.transport.position;
                const secondsPerTick = 60 / (currentDoc.bpm * PPQ);
                const clipStartTick = currentTarget.startBar * BAR_TICKS;
                const offsetSec = (currentTarget.offsetSec ?? 0) + (currentTarget.trimStart ?? 0);
                // Map buffer transient times to ticks: tick = clipStart + (t - offset)/stretch / secPerTick
                const ticks = times.map(
                  (t) => clipStartTick + (t - offsetSec) / secondsPerTick / (currentTarget.stretchRate ?? 1),
                );
                // Filter to those inside clip
                const valid = ticks.filter(
                  (tk) =>
                    tk >= clipStartTick &&
                    tk < clipStartTick + currentTarget.lengthBars * BAR_TICKS &&
                    Number.isFinite(tk),
                );
                let nextTick: number | null = null;
                if (!backwards) {
                  nextTick = valid.find((tk) => tk > activePos + 1) ?? null;
                  if (nextTick === null) {
                    // wrap to next clip's first transient
                    const sorted = [...currentClips].sort((a, b) => a.startBar - b.startBar);
                    const idx = sorted.findIndex((c) => c.id === currentTarget.id);
                    const nxt = sorted[(idx + 1) % sorted.length];
                    if (nxt && nxt.id !== currentTarget.id) {
                      const nb = services.bank.get(nxt.bufferId);
                      if (nb) {
                        const nt = await detectTransientsAsync(nb.getChannelData(0), nb.sampleRate, 1, controller.signal);
                        if (request !== transientJumpRef.current) return;
                        if (nt.length > 0)
                          nextTick =
                            nxt.startBar * BAR_TICKS +
                            (nt[0] - (nxt.offsetSec ?? 0)) / secondsPerTick / (nxt.stretchRate ?? 1);
                      }
                    }
                  }
                } else {
                  const prevs = valid.filter((tk) => tk < activePos - 1);
                  nextTick = prevs.length > 0 ? prevs[prevs.length - 1] : null;
                  if (nextTick === null) {
                    const sorted = [...currentClips].sort((a, b) => a.startBar - b.startBar);
                    const idx = sorted.findIndex((c) => c.id === currentTarget.id);
                    const prv = sorted[(idx - 1 + sorted.length) % sorted.length];
                    if (prv && prv.id !== currentTarget.id) {
                      const pb = services.bank.get(prv.bufferId);
                      if (pb) {
                        const pt = await detectTransientsAsync(pb.getChannelData(0), pb.sampleRate, 1, controller.signal);
                        if (request !== transientJumpRef.current) return;
                        if (pt.length > 0) {
                          const last = pt[pt.length - 1];
                          nextTick =
                            prv.startBar * BAR_TICKS +
                            (last - (prv.offsetSec ?? 0)) / secondsPerTick / (prv.stretchRate ?? 1);
                        }
                      }
                    }
                  }
                }
                if (nextTick !== null && Number.isFinite(nextTick)) {
                  services.playback.seek(Math.max(0, Math.floor(nextTick)));
                }
              })().catch((error) => {
                if (!controller.signal.aborted) console.warn("[App] transient navigation failed:", error);
              }).finally(() => {
                if (transientJumpAbortRef.current === controller) transientJumpAbortRef.current = null;
              });
              return;
            }
          }
          // Handled Tab for audioClips — don't fall through to nextTrack
          event.preventDefault();
          return;
        }
      }

      // Ctrl/Cmd+E — Separate at playhead (PT separate clip)
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "e") {
        const pos = services.transport.position;
        const clip = (doc.arrangement.audioClips ?? []).find((c) => {
          const s = c.startBar * BAR_TICKS;
          const e2 = s + c.lengthBars * BAR_TICKS;
          return pos > s && pos < e2;
        });
        if (clip) {
          event.preventDefault();
          try {
            services.store.execute(splitAudioClipAtTick(doc, clip.id, pos));
          } catch {}
          return;
        }
      }

      // Strip Silence + Consolidate helpers are in ArrangementPanel's audioMenu; Tab+B here is bounce which is handled above (Ctrl+B)

      // Range Tool: P = locators to selection (Cubase) — set loop to timeRange
      // or the selection bbox. Runs BEFORE the tool switcher: P used to be
      // consumed by the toolMap and this branch was unreachable. With no
      // selection P still falls through to the pencil tool.
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
        const hasSel =
          selection.timeRange ||
          selection.clipIds.length > 0 ||
          selection.noteSelections.length > 0 ||
          selection.stepSelection ||
          selection.trackIds.length > 1;
        if (hasSel) {
          let from = selection.timeRange?.fromTick;
          let to = selection.timeRange?.toTick;
          if (from === undefined || to === undefined) {
            let min = Infinity;
            let max = -Infinity;
            if (selection.clipIds.length > 0) {
              for (const cid of selection.clipIds) {
                const c = doc.arrangement.clips.find((x) => x.id === cid);
                if (c) {
                  const s = c.startBar * BAR_TICKS;
                  const e = (c.startBar + c.lengthBars) * BAR_TICKS;
                  min = Math.min(min, s);
                  max = Math.max(max, e);
                }
              }
              for (const ac of doc.arrangement.audioClips ?? [])
                if (selection.clipIds.includes(ac.id)) {
                  const s = ac.startBar * BAR_TICKS;
                  const e = (ac.startBar + ac.lengthBars) * BAR_TICKS;
                  min = Math.min(min, s);
                  max = Math.max(max, e);
                }
            }
            if (selection.noteSelections.length > 0) {
              for (const ns of selection.noteSelections) {
                const pat = doc.patterns.find((p) => p.id === doc.activePatternId);
                const list = pat?.notes?.[ns.trackId] ?? [];
                for (const nid of ns.noteIds) {
                  const n = list.find((x) => x.id === nid);
                  if (n) {
                    min = Math.min(min, n.start);
                    max = Math.max(max, n.start + n.duration);
                  }
                }
              }
            }
            if (selection.stepSelection) {
              const ss = selection.stepSelection;
              min = Math.min(min, ss.from * STEP_TICKS);
              max = Math.max(max, (ss.to + 1) * STEP_TICKS);
            }
            if (min !== Infinity && max !== -Infinity) {
              from = min;
              to = max;
            }
          }
          if (from !== undefined && to !== undefined && to > from) {
            event.preventDefault();
            services.transport.setLoop(true, from, to);
            return;
          }
        }
      }

      // Ctrl/Cmd+A — select all notes of the active instrument pattern.
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

      // Tool switching: S/C/B/E/M without modifiers, Esc handled above already resets tool.
      // P is reserved for the locator shortcut above when a selection exists.
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

      // Range Tool: Ctrl/Cmd+B bounce in Range (like Cubase Render in Place).
      // This is deliberately async: the buffer must be rendered from the
      // selected project content before the AudioClip is committed.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        if (selection.timeRange) {
          const fromBar = selection.timeRange.fromTick / BAR_TICKS;
          const lenBars = (selection.timeRange.toTick - selection.timeRange.fromTick) / BAR_TICKS;
          if (lenBars >= 0.25) {
            event.preventDefault();
            if (bouncingRange) return;
            const trackIds = (selection.trackIds.length > 0 ? selection.trackIds : doc.tracks.map((t) => t.id)).filter(
              (id) => doc.tracks.some((t) => t.id === id && t.kind !== "group"),
            );
            const trackId = trackIds[0];
            if (!trackId) return;
            const sourceDoc = doc;
            setBouncingRange(true);
            void (async () => {
              try {
                const zoneDoc = buildBounceZoneDoc(sourceDoc, trackIds, { startBar: fromBar, lengthBars: lenBars });
                const liveContext = (services.engine as { getLiveAudioContext?: () => AudioContext | null })
                  .getLiveAudioContext?.();
                const buffer = await renderProject(zoneDoc, services.bank, {
                  mode: "song",
                  sampleRate: liveContext?.sampleRate ?? 44100,
                  tailSeconds: 0.35,
                });
                const bufferId = userSampleId(`bounce-${Math.round(fromBar)}b`);
                services.bank.add(bufferId, buffer);
                // Bank entries are runtime-only. Persist the rendered WAV so
                // the new clip remains playable after a reload.
                try {
                  await services.userSamples.save(
                    {
                      id: bufferId,
                      name: `Bounce ${Math.round(fromBar) + 1}`,
                      fileName: `${bufferId}.wav`,
                      category: "Custom",
                      duration: buffer.duration,
                      sampleRate: buffer.sampleRate,
                      channels: buffer.numberOfChannels,
                      createdAt: new Date().toISOString(),
                    },
                    encodeWav(buffer, 16),
                  );
                } catch (error) {
                  console.warn("[App] bounce persistence failed; clip is available for this session:", error);
                }
                const currentDoc = services.store.doc;
                if (currentDoc.tracks.some((track) => track.id === trackId)) {
                  services.store.execute(
                    addAudioClip(currentDoc, trackId, bufferId, fromBar, lenBars, { gain: 1, stretchRate: 1 }),
                  );
                } else {
                  services.bank.remove(bufferId);
                  await services.userSamples.remove(bufferId);
                }
              } catch (error) {
                console.error("[App] range bounce failed:", error);
              } finally {
                setBouncingRange(false);
              }
            })();
            return;
          }
        }
        // let PianoRoll's Ctrl+B duplicate notes handle it (don't prevent)
      }

      // Range Tool: X crossfade (Cubase) — for audioClips/transitions inside timeRange or selected clips
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "x") {
        if (selection.timeRange || selection.clipIds.length > 0) {
          let did = false;
          // AudioClips crossfade: set fadeIn/Out 0.08 on clips intersecting range/selection
          const rangeFrom = selection.timeRange?.fromTick ?? 0;
          const rangeTo = selection.timeRange?.toTick ?? 0;
          const hasRange = !!selection.timeRange;
          for (const ac of doc.arrangement.audioClips ?? []) {
            const cFrom = ac.startBar * BAR_TICKS;
            const cTo = (ac.startBar + ac.lengthBars) * BAR_TICKS;
            const inRange = hasRange ? cFrom < rangeTo && cTo > rangeFrom : selection.clipIds.includes(ac.id);
            if (inRange) {
              try {
                services.store.execute(updateAudioClip(doc, ac.id, { fadeIn: 0.08, fadeOut: 0.08 }));
              } catch {}
              did = true;
            }
          }
          // Arrangement transitions crossfade: create transition between adjacent clips inside range
          if (hasRange) {
            const clips = [...doc.arrangement.clips].sort((a, b) => a.startBar - b.startBar);
            for (let i = 0; i < clips.length - 1; i++) {
              const a = clips[i];
              const b = clips[i + 1];
              const aEnd = (a.startBar + a.lengthBars) * BAR_TICKS;
              const bStart = b.startBar * BAR_TICKS;
              const gap = bStart - aEnd;
              if (Math.abs(gap) < BAR_TICKS * 0.5 && aEnd >= rangeFrom && bStart <= rangeTo) {
                const exists = doc.arrangement.transitions?.some((t) => t.fromClipId === a.id && t.toClipId === b.id);
                if (!exists) {
                  try {
                    services.store.execute(addArrangementTransition(doc, a.id, b.id, "custom", 1));
                  } catch {}
                  did = true;
                }
              }
            }
          }
          if (did) {
            event.preventDefault();
            return;
          }
        }
      }

      const matched = matchShortcut(event);
      if (!matched) return;
      runShortcutRef.current(matched, event);
    };
    window.addEventListener("keydown", handler);
    return () => {
      transientJumpRef.current++;
      transientJumpAbortRef.current?.abort();
      transientJumpAbortRef.current = null;
      window.removeEventListener("keydown", handler);
    };
  }, [services, doc, track, selection, helpOpen, selectionStore, tool, contextMenu, toolStore, bouncingRange]);

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
    // A cancelled pointer must not fire the hold timer afterwards.
    const onPointerCancel = () => {
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      holdStartRef.current = null;
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("contextmenu", onContextMenu);
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    };
  }, [selection]);

  const panelRenderers: Record<BottomPanel, React.ReactNode> = {
    mixer: (
      <ErrorBoundary panel="mixer">
        <Mixer />
      </ErrorBoundary>
    ),
    fx: (
      <ErrorBoundary panel="fx">
        <EffectRack track={track} />
      </ErrorBoundary>
    ),
    arr: (
      <ErrorBoundary panel="arr">
        <ArrangementPanel />
      </ErrorBoundary>
    ),
    mod: (
      <ErrorBoundary panel="mod">
        <ModPanel />
      </ErrorBoundary>
    ),
    exp: (
      <ErrorBoundary panel="exp">
        <ExportPanel selectedTrackId={track.id} selectedTrackName={track.name} />
      </ErrorBoundary>
    ),
    midi: (
      <ErrorBoundary panel="midi">
        <MidiPanel
          selectedTrackId={track.id}
          selectedNote={selectedNote}
          scaleSnap={scaleSnap}
          onToggleScaleSnap={() => setScaleSnap((value) => !value)}
          onClearSelection={() => setSelectedNote(null)}
        />
      </ErrorBoundary>
    ),
    dice: (
      <ErrorBoundary panel="dice">
        <DiceTray />
      </ErrorBoundary>
    ),
  };
  const renderDockSlot = (id: BottomPanel | null) => (id === null ? null : panelRenderers[id]);

  const paletteDeps = useMemo(
    (): PaletteDeps => ({
        runShortcut: (key) => runShortcutRef.current(key),
        snapshotNow: () => {
          void services.core.snapshots
            .save(doc.id, doc, `Manual — ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`)
            .then(() => services.core.snapshots.prune(doc.id))
            .catch(() => {});
        },
        openGallery: () => window.open("/gallery", "_blank", "noopener"),
        toggleHistoryPanel: () => setHistoryOpen((v) => !v),
        toggleDiagnostics: () => setDiagnosticsOpen((v) => !v),
      }),
    [services, doc],
  );

  return (
    <ServicesContext.Provider value={services}>
      <DiceProvider doc={doc}>
        <SelectionContext.Provider value={selectionStore}>
          <ToolContext.Provider value={toolStore}>
            <AudioUnlock />
            <OnboardingTour />
            <div className="app">
              <TopBar
                diagnosticsOpen={diagnosticsOpen}
                bottomPanel={bottomPanel}
                splitPanel={splitPanel}
                playMode={playMode}
                onSetPlayMode={services.playback.setMode}
                onToggleDiagnostics={() => setDiagnosticsOpen((open) => !open)}
                onSetBottomPanel={setBottomPanelTab}
                onToggleHelp={() => setHelpOpen((v) => !v)}
                onOpenPalette={() => setPaletteOpen(true)}
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
                  <PatternBar clip={clip} onCopy={setClip} onOpenDice={() => setBottomPanel("dice")} />
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
                <Inspector track={track} selectedPadId={padId} onOpenPlugin={() => setPluginTrackId(track.id)} />
              </main>
              <div
                className={
                  "bottom-panels" +
                  (sheetCollapsed ? " sheet-collapsed" : "") +
                  (dock.slotB !== null ? " dock-split" : "")
                }
                style={{ "--dock-height": `${dock.height}px` } as React.CSSProperties}
              >
                <button
                  type="button"
                  className="dock-resize-handle"
                  aria-label="Resize bottom panel"
                  title="Drag to resize the panel dock"
                  onPointerDown={startDockResize}
                >
                  <span aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sheet-handle"
                  aria-expanded={!sheetCollapsed}
                  aria-label={sheetCollapsed ? "Expand bottom panel" : "Collapse bottom panel"}
                  title={sheetCollapsed ? "Expand panel" : "Collapse panel"}
                  onClick={() => setSheetCollapsed((v) => !v)}
                >
                  <span className="sheet-handle-bar" aria-hidden="true" />
                </button>
                {!sheetCollapsed && (
                  <div className="dock-slot">
                    <Suspense fallback={<div className="panel-loading">Loading panel…</div>}>
                      {renderDockSlot(dock.slotA)}
                    </Suspense>
                  </div>
                )}
                {!sheetCollapsed && dock.slotB !== null && (
                  <div className="dock-slot">
                    <Suspense fallback={<div className="panel-loading">Loading panel…</div>}>
                      {renderDockSlot(dock.slotB)}
                    </Suspense>
                  </div>
                )}
              </div>
              {diagnosticsOpen && (
                <ErrorBoundary panel="diagnostics">
                  <Diagnostics />
                </ErrorBoundary>
              )}
              <footer className="statusbar">
                <span>
                  SPACE play · CTRL+K commands · ALT+1–6 panels · ? help · Ctrl+Z undo · <kbd className="statusbar-kbd">1</kbd>–
                  <kbd className="statusbar-kbd">9</kbd> tracks · TOOL {tool.toUpperCase()} (S/C/B/E/M)
                </span>
              </footer>
              <CommandToast />
              {captureOffer && services.capture.hasCapturedMaterial && (
                <div
                  className="context-menu"
                  role="alertdialog"
                  aria-label="Capture last take"
                  style={{ left: 16, bottom: 48, top: "auto" }}
                >
                  <div className="context-menu-header">CAPTURE LAST TAKE</div>
                  <span style={{ fontSize: 11, color: "var(--muted)", padding: "0 8px 4px", display: "block" }}>
                    {services.capture.capturedEventCount} played events — keep them as a pattern?
                  </span>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const cmd = services.capture.captureLastTake();
                      if (cmd) {
                        try {
                          services.store.execute(cmd);
                        } catch {
                          /* ignore */
                        }
                      }
                      setCaptureOffer(false);
                    }}
                  >
                    Capture (A)
                  </button>
                  <button type="button" role="menuitem" onClick={() => setCaptureOffer(false)}>
                    Discard (Esc)
                  </button>
                </div>
              )}
              <UndoHistoryPanel open={historyOpen} />
              <InstallPrompt />
              <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
              <Suspense fallback={null}>
                <PaletteOverlay open={paletteOpen} deps={paletteDeps} onClose={() => setPaletteOpen(false)} />
              </Suspense>
              <OnboardingHint />
              <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
              {pluginTrackId && (
                <FloatingPlugin trackId={pluginTrackId} selectedPadId={padId} onClose={() => setPluginTrackId(null)} />
              )}
            </div>
          </ToolContext.Provider>
        </SelectionContext.Provider>
      </DiceProvider>
    </ServicesContext.Provider>
  );
}
