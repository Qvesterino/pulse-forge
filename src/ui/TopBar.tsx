import { useState } from "react";
import { useDoc, useSaveStatus, useServices } from "./context";
import { useTransportPosition } from "./playhead";
import { DragNumber } from "./controls";
import { setBpm, setProjectName } from "../commands/commands";
import type { PlayMode } from "../project-model/types";

export function TopBar({
  onToggleDiagnostics,
  diagnosticsOpen,
  onSetBottomPanel,
  bottomPanel,
  onToggleHelp,
  playMode,
  onSetPlayMode,
}: {
  onToggleDiagnostics: () => void;
  diagnosticsOpen: boolean;
  onSetBottomPanel: (panel: "mixer" | "fx" | "arr" | "mod" | "exp") => void;
  bottomPanel: "mixer" | "fx" | "arr" | "mod" | "exp" | null;
  onToggleHelp: () => void;
  playMode: PlayMode;
  onSetPlayMode: (mode: PlayMode) => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const saveStatus = useSaveStatus();
  const position = useTransportPosition(services.transport);
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const playing = services.transport.playing;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">PF</span>
        <span className="brand-name">PULSE FORGE</span>
      </div>

      <div className="transport-cluster">
        <button
          type="button"
          className={`btn btn-mode${playMode === "song" ? " active-song" : ""}`}
          onClick={() => onSetPlayMode(playMode === "pattern" ? "song" : "pattern")}
          title="Toggle play mode: pattern loop or arrangement song"
        >
          {playMode === "pattern" ? "PATTERN" : "SONG"}
        </button>
        <button
          type="button"
          className={`btn btn-play${playing ? " active" : ""}`}
          onClick={() => services.playback.playPause()}
          title="Play / Pause (Space)"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          className="btn btn-stop"
          onClick={() => services.playback.stop()}
          title="Stop"
        >
          ■
        </button>
        <span className="position-display">{position}</span>
        <DragNumber
          label="BPM"
          value={doc.bpm}
          min={20}
          max={300}
          defaultValue={124}
          sensitivity={0.4}
          format={(v) => v.toFixed(1)}
          onCommit={(bpm) => services.store.execute(setBpm(doc, bpm))}
        />
      </div>

      <input
        className="project-name"
        value={nameDraft ?? doc.name}
        aria-label="Project name"
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={() => {
          if (nameDraft !== null && nameDraft.trim() !== "" && nameDraft !== doc.name) {
            services.store.execute(setProjectName(doc, nameDraft.trim()));
          }
          setNameDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />

      <div className="topbar-right">
        <span className={`save-status save-${saveStatus}`} title={`Save status: ${saveStatus}`}>
          {saveStatus === "saved" && "SAVED"}
          {saveStatus === "dirty" && "UNSAVED"}
          {saveStatus === "saving" && "SAVING…"}
          {saveStatus === "error" && "SAVE ERROR"}
        </span>
        <button
          type="button"
          className={`btn btn-ghost${bottomPanel === "mixer" ? " active" : ""}`}
          onClick={() => onSetBottomPanel("mixer")}
          title="Toggle mixer panel (1)"
          aria-label="Toggle mixer panel"
          aria-pressed={bottomPanel === "mixer"}
        >
          MIX
        </button>
        <button
          type="button"
          className={`btn btn-ghost${bottomPanel === "fx" ? " active" : ""}`}
          onClick={() => onSetBottomPanel("fx")}
          title="Toggle effect rack (2)"
          aria-label="Toggle effect rack"
          aria-pressed={bottomPanel === "fx"}
        >
          FX
        </button>
        <button
          type="button"
          className={`btn btn-ghost${bottomPanel === "arr" ? " active" : ""}`}
          onClick={() => onSetBottomPanel("arr")}
          title="Toggle arrangement and scenes (3)"
          aria-label="Toggle arrangement and scenes"
          aria-pressed={bottomPanel === "arr"}
        >
          ARR
        </button>
        <button
          type="button"
          className={`btn btn-ghost${bottomPanel === "mod" ? " active" : ""}`}
          onClick={() => onSetBottomPanel("mod")}
          title="Toggle automation, LFOs and macros (4)"
          aria-label="Toggle modulation panel"
          aria-pressed={bottomPanel === "mod"}
        >
          MOD
        </button>
        <button
          type="button"
          className={`btn btn-ghost btn-export-toggle${bottomPanel === "exp" ? " active" : ""}`}
          onClick={() => onSetBottomPanel("exp")}
          title="Toggle export panel (5)"
          aria-label="Toggle export panel"
          aria-pressed={bottomPanel === "exp"}
        >
          EXPORT
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onToggleHelp}
          title="Show keyboard shortcuts (?)"
          aria-label="Show keyboard shortcuts"
        >
          ?
        </button>
        <button
          type="button"
          className={`btn btn-ghost${diagnosticsOpen ? " active" : ""}`}
          onClick={onToggleDiagnostics}
          title="Toggle diagnostics panel"
          aria-label="Toggle diagnostics panel"
          aria-pressed={diagnosticsOpen}
        >
          DIAG
        </button>
      </div>
    </header>
  );
}
