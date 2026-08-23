import { useEffect, useState, useSyncExternalStore } from "react";
import type { Services } from "../services";
import { ServicesContext } from "./context";
import { TopBar } from "./TopBar";
import { TrackTabs } from "./TrackTabs";
import { RackStrip } from "./RackStrip";
import { Sequencer } from "./Sequencer";
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
import {
  clearSteps,
  deleteNote,
  duplicatePattern,
  setActivePattern,
  setTrackParams,
} from "../commands/commands";
import type { PatternClipboard } from "../commands/commands";
import type { SelectedNote } from "./PianoRoll";
import { matchShortcut } from "./shortcuts";
import { BAR_TICKS } from "../project-model/types";
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
  const playMode = useSyncExternalStore(services.playback.subscribe, services.playback.getSnapshot, services.playback.getSnapshot);
  const [selectedTrackId, setSelectedTrackId] = useState(doc.tracks[0]?.id ?? "");
  const [selectedPadId, setSelectedPadId] = useState(
    doc.tracks[0]?.kind === "drum" ? doc.tracks[0].pads[0]?.id ?? "" : "",
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [bottomPanel, setBottomPanel] = useState<BottomPanel | null>("mixer");
  const [clip, setClip] = useState<PatternClipboard | null>(null);
  const [selectedNote, setSelectedNote] = useState<SelectedNote | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [stepSelection, setStepSelection] = useState<StepSelection | null>(null);
  const [scaleSnap, setScaleSnap] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const track = doc.tracks.find((t) => t.id === selectedTrackId) ?? doc.tracks[0];
  const padId =
    track.kind === "drum" && track.pads.some((p) => p.id === selectedPadId)
      ? selectedPadId
      : track.kind === "drum"
        ? track.pads[0]?.id ?? ""
        : "";

  const selectTrack = (trackId: string) => {
    setSelectedTrackId(trackId);
    setSelectedNote(null);
    const next = doc.tracks.find((t) => t.id === trackId);
    if (next?.kind === "drum") setSelectedPadId(next.pads[0]?.id ?? "");
  };

  const setBottomPanelTab = (panel: BottomPanel) =>
    setBottomPanel((current) => (current === panel ? null : panel));

  // A step selection belongs to the pattern it was made in.
  useEffect(() => {
    setStepSelection(null);
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
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      // Escape is contextual: close help → clear note selection → clear step
      // selection → blur inputs; only when nothing applies does it stop the
      // transport (matched as the "stop" shortcut below).
      if (event.key === "Escape") {
        if (helpOpen) {
          setHelpOpen(false);
          event.preventDefault();
          return;
        }
        if (selectedNote) {
          setSelectedNote(null);
          event.preventDefault();
          return;
        }
        if (stepSelection) {
          setStepSelection(null);
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
          const panel = matched.slice(5).toLowerCase() as BottomPanel;
          setBottomPanelTab(panel);
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
        case "duplicatePattern":
          event.preventDefault();
          services.store.execute(duplicatePattern(doc, doc.activePatternId));
          return;
        case "deleteNote":
          if (selectedNote) {
            event.preventDefault();
            services.store.execute(deleteNote(doc, selectedNote.trackId, selectedNote.noteId));
            setSelectedNote(null);
          } else if (stepSelection) {
            event.preventDefault();
            services.store.execute(
              clearSteps(doc, doc.activePatternId, stepSelection.padIds, stepSelection.from, stepSelection.to),
            );
            setStepSelection(null);
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
  }, [services, doc, track, selectedNote, helpOpen, stepSelection]);

  return (
    <ServicesContext.Provider value={services}>
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
        {bottomPanel === "mixer" && <Mixer />}
        {bottomPanel === "fx" && <EffectRack track={track} />}
        {bottomPanel === "arr" && <ArrangementPanel />}
        {bottomPanel === "mod" && <ModPanel />}
        {bottomPanel === "exp" && <ExportPanel />}
        {bottomPanel === "midi" && <MidiPanel />}
        {diagnosticsOpen && <Diagnostics />}
        <footer className="statusbar">
          <span>
            SPACE play · 1–5 panels · ? help · Ctrl+Z undo · <kbd className="statusbar-kbd">1</kbd>–
            <kbd className="statusbar-kbd">9</kbd> tracks
          </span>
        </footer>
        <CommandToast />
        <UndoHistoryPanel open={historyOpen} />
        <InstallPrompt />
        <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
        <OnboardingHint />
      </div>
    </ServicesContext.Provider>
  );
}
