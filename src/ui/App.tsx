import { useEffect, useState, useSyncExternalStore } from "react";
import type { Services } from "../services";
import { ServicesContext } from "./context";
import { TopBar } from "./TopBar";
import { TrackTabs } from "./TrackTabs";
import { RackStrip } from "./RackStrip";
import { Sequencer } from "./Sequencer";
import { Inspector } from "./Inspector";
import { Diagnostics } from "./Diagnostics";
import { PatternBar } from "./PatternBar";
import { Mixer } from "./Mixer";
import { EffectRack } from "./EffectRack";
import { ArrangementPanel } from "./ArrangementPanel";
import { ModPanel } from "./ModPanel";
import { deleteNote, duplicatePattern } from "../commands/commands";
import type { PatternClipboard } from "../commands/commands";
import type { SelectedNote } from "./PianoRoll";

export function App({ services }: { services: Services }) {
  const doc = useSyncExternalStore(services.store.subscribe, services.store.getDoc, services.store.getDoc);
  const [selectedTrackId, setSelectedTrackId] = useState(doc.tracks[0]?.id ?? "");
  const [selectedPadId, setSelectedPadId] = useState(
    doc.tracks[0]?.kind === "drum" ? doc.tracks[0].pads[0]?.id ?? "" : "",
  );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [bottomPanel, setBottomPanel] = useState<"mixer" | "fx" | "arr" | "mod" | null>("mixer");
  const [clip, setClip] = useState<PatternClipboard | null>(null);
  const [selectedNote, setSelectedNote] = useState<SelectedNote | null>(null);

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

  const setBottomPanelTab = (panel: "mixer" | "fx" | "arr" | "mod") =>
    setBottomPanel((current) => (current === panel ? null : panel));

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      if (event.code === "Space") {
        event.preventDefault();
        services.playback.playPause();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        services.store.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
        event.preventDefault();
        services.store.redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void services.flushSave();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        services.store.execute(duplicatePattern(services.store.doc, services.store.doc.activePatternId));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedNote) {
          event.preventDefault();
          services.store.execute(deleteNote(services.store.doc, selectedNote.trackId, selectedNote.noteId));
          setSelectedNote(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [services, selectedNote]);

  return (
    <ServicesContext.Provider value={services}>
      <div className="app">
        <TopBar
          diagnosticsOpen={diagnosticsOpen}
          bottomPanel={bottomPanel}
          onToggleDiagnostics={() => setDiagnosticsOpen((open) => !open)}
          onSetBottomPanel={setBottomPanelTab}
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
            />
          </div>
          <Inspector track={track} selectedPadId={padId} />
        </main>
        {bottomPanel === "mixer" && <Mixer />}
        {bottomPanel === "fx" && <EffectRack track={track} />}
        {bottomPanel === "arr" && <ArrangementPanel />}
        {bottomPanel === "mod" && <ModPanel />}
        {diagnosticsOpen && <Diagnostics />}
        <footer className="statusbar">
          <span>
            SPACE play · PATTERN/SONG mode in transport · CTRL+D duplicate pattern · ARR = scenes + arrangement · MOD = automation + LFO + macros
          </span>
        </footer>
      </div>
    </ServicesContext.Provider>
  );
}
