import { useEffect, useState } from "react";
import { useCanRedo, useCanUndo, useDoc, useLastSavedAt, useSaveStatus, useServices } from "./context";
import { useTransportPosition } from "./playhead";
import { DragNumber } from "./controls";
import { setBpm, setProjectName } from "../commands/commands";
import { barAtTick, beatAtTick } from "../project-model/schema";
import { STEP_TICKS } from "../project-model/types";
import type { PlayMode } from "../project-model/types";
import type { Services } from "../services";
import { matchShortcut } from "./shortcuts";
import { ScalePanel } from "./ScalePanel";
import { ThemePanel } from "./ThemePanel";
import { CollabPanel } from "./CollabPanel";
import { AssistPanel } from "./AssistPanel";
import { assistFill, assistVary } from "../commands/commands";
import { nextSeed } from "../shared/dice";

function formatClock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TopBar({
  onToggleDiagnostics,
  diagnosticsOpen,
  onSetBottomPanel,
  bottomPanel,
  splitPanel,
  onToggleHelp,
  onOpenPalette,
  playMode,
  onSetPlayMode,
  onOpenBrowser,
  onReplaceServices,
  scaleSnap,
  onToggleScaleSnap,
  historyOpen,
  onToggleHistory,
}: {
  onToggleDiagnostics: () => void;
  diagnosticsOpen: boolean;
  onSetBottomPanel: (panel: "mixer" | "fx" | "arr" | "mod" | "exp" | "midi" | "dice", split?: boolean) => void;
  bottomPanel: "mixer" | "fx" | "arr" | "mod" | "exp" | "midi" | "dice" | null;
  splitPanel: "mixer" | "fx" | "arr" | "mod" | "exp" | "midi" | "dice" | null;
  onToggleHelp: () => void;
  /** Optional — the ⌘K palette button renders only when provided. */
  onOpenPalette?: () => void;
  playMode: PlayMode;
  onSetPlayMode: (mode: PlayMode) => void;
  onOpenBrowser: () => void;
  onReplaceServices: (services: Services) => void;
  scaleSnap: boolean;
  onToggleScaleSnap: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const saveStatus = useSaveStatus();
  const lastSavedAt = useLastSavedAt();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const position = useTransportPosition(services.transport, doc);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(services.transport.loopEnabled);
  const [loopStart, setLoopStart] = useState(services.transport.loopStart);
  const [loopEnd, setLoopEnd] = useState(services.transport.loopEnd);
  const [scalePanelOpen, setScalePanelOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);

  // Transport is not reactive — reading `playing` at render time goes stale
  // when playback is toggled from elsewhere (Space shortcut, Esc stop…).
  // PlaybackController.notify() fires on every play/pause/stop/seek.
  const [playing, setPlaying] = useState(services.transport.playing);
  useEffect(() => {
    const unsubscribe = services.playback.subscribe(() => setPlaying(services.transport.playing));
    setPlaying(services.transport.playing);
    return unsubscribe;
  }, [services.playback, services.transport]);

  const toggleLoop = () => {
    const next = !loopEnabled;
    services.transport.setLoop(next, loopStart, loopEnd);
    setLoopEnabled(next);
  };

  const commitLoopStart = (v: number) => {
    const next = Math.max(0, Math.floor(v));
    services.transport.setLoop(loopEnabled, next, loopEnd);
    setLoopStart(next);
  };

  const commitLoopEnd = (v: number) => {
    const next = Math.floor(v);
    services.transport.setLoop(loopEnabled, loopStart, next);
    setLoopEnd(next);
  };

  const formatBarBeat = (v: number) => {
    const bar = barAtTick(v, doc);
    const beat = beatAtTick(v, doc);
    return `${bar}.${beat}`;
  };

  // "L" toggles the loop region. Handled here because loop state lives here.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;
      if (matchShortcut(event) === "toggleLoop") {
        event.preventDefault();
        toggleLoop();
      }
      // 1-klik Assist shortcuts — deterministic, no panel
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        const seed = nextSeed(doc.activePatternId + String(Date.now()), "topbar-vary");
        services.store.execute(assistVary(doc, doc.activePatternId, seed, 0.6));
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        const seed = nextSeed(doc.activePatternId + String(Date.now()), "topbar-fill");
        services.store.execute(assistFill(doc, doc.activePatternId, seed));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopEnabled, loopStart, loopEnd, doc, services.store]);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PF</span>
          <span className="brand-name">PULSE FORGE</span>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-projects"
          onClick={onOpenBrowser}
          title="Back to project browser"
          aria-label="Back to project browser"
        >
          PROJECTS
        </button>

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
          <button type="button" className="btn btn-stop" onClick={() => services.playback.stop()} title="Stop">
            ■
          </button>
          <button
            type="button"
            className={`btn btn-countin${services.transport.countInBars > 0 ? " active" : ""}`}
            onClick={() => services.transport.setCountIn((services.transport.countInBars + 1) % 3)}
            title="Metronome count-in before playback (1/2 bars) — FL/Cubase pre-roll"
          >
            C{services.transport.countInBars > 0 ? services.transport.countInBars : "·"}
          </button>
          <button
            type="button"
            className={`btn btn-preroll${services.transport.preRollBars > 0 ? " active" : ""}`}
            onClick={() => services.transport.setPreRoll(services.transport.preRollBars > 0 ? 0 : 1)}
            title="Pre-roll: play 1 bar before the playhead (clicks only, content starts on time)"
          >
            PR
          </button>
          <button
            type="button"
            className="btn btn-history"
            disabled={!canUndo}
            onClick={() => services.store.undo()}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            aria-keyshortcuts="Control+Z"
          >
            ↶
          </button>
          <button
            type="button"
            className="btn btn-history"
            disabled={!canRedo}
            onClick={() => services.store.redo()}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            aria-keyshortcuts="Control+Shift+Z"
          >
            ↷
          </button>
          <span className="position-display">{position}</span>
          <button
            type="button"
            className={`btn btn-loop${loopEnabled ? " active" : ""}`}
            onClick={toggleLoop}
            title="Toggle loop region (L)"
            aria-label="Toggle loop region"
            aria-pressed={loopEnabled}
          >
            LOOP
          </button>
          {loopEnabled && (
            <>
              <DragNumber
                label="IN"
                value={loopStart}
                min={0}
                max={loopEnd > 0 ? loopEnd : Number.MAX_SAFE_INTEGER}
                defaultValue={0}
                sensitivity={STEP_TICKS}
                format={formatBarBeat}
                onCommit={commitLoopStart}
              />
              <DragNumber
                label="OUT"
                value={loopEnd}
                min={loopStart}
                max={Number.MAX_SAFE_INTEGER}
                defaultValue={0}
                sensitivity={STEP_TICKS}
                format={formatBarBeat}
                onCommit={commitLoopEnd}
              />
            </>
          )}
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
          <span
            className={`save-status save-${saveStatus}`}
            title={
              saveStatus === "saved"
                ? `All changes saved${lastSavedAt ? ` at ${formatClock(lastSavedAt)}` : ""}. Autosave is on.`
                : saveStatus === "dirty"
                  ? "Unsaved changes — autosave runs in a moment (Ctrl+S to save now)"
                  : saveStatus === "saving"
                    ? "Saving…"
                    : "Save failed — click to retry"
            }
            role={saveStatus === "error" ? "button" : undefined}
            onClick={saveStatus === "error" ? () => void services.flushSave() : undefined}
          >
            {saveStatus === "saved" && `SAVED${lastSavedAt ? ` ${formatClock(lastSavedAt)}` : ""}`}
            {saveStatus === "dirty" && "UNSAVED"}
            {saveStatus === "saving" && "SAVING…"}
            {saveStatus === "error" && "SAVE ERROR — RETRY"}
          </span>
          <button
            type="button"
            className={`btn btn-ghost${bottomPanel === "mixer" || splitPanel === "mixer" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("mixer", event.ctrlKey || event.metaKey)}
            title="Toggle mixer panel (1)"
            aria-label="Toggle mixer panel"
            aria-pressed={bottomPanel === "mixer" || splitPanel === "mixer"}
          >
            MIX
          </button>
          <button
            type="button"
            className={`btn btn-ghost${bottomPanel === "fx" || splitPanel === "fx" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("fx", event.ctrlKey || event.metaKey)}
            title="Toggle effect rack (2)"
            aria-label="Toggle effect rack"
            aria-pressed={bottomPanel === "fx" || splitPanel === "fx"}
          >
            FX
          </button>
          <button
            type="button"
            className={`btn btn-ghost${bottomPanel === "arr" || splitPanel === "arr" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("arr", event.ctrlKey || event.metaKey)}
            title="Toggle arrangement and scenes (3)"
            aria-label="Toggle arrangement and scenes"
            aria-pressed={bottomPanel === "arr" || splitPanel === "arr"}
          >
            ARR
          </button>
          <button
            type="button"
            className={`btn btn-ghost${bottomPanel === "mod" || splitPanel === "mod" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("mod", event.ctrlKey || event.metaKey)}
            title="Toggle automation, LFOs and macros (4)"
            aria-label="Toggle modulation panel"
            aria-pressed={bottomPanel === "mod" || splitPanel === "mod"}
          >
            MOD
          </button>
          <button
            type="button"
            className={`btn btn-ghost btn-export-toggle${bottomPanel === "exp" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("exp", event.ctrlKey || event.metaKey)}
            title="Toggle export panel (5)"
            aria-label="Toggle export panel"
            aria-pressed={bottomPanel === "exp" || splitPanel === "exp"}
          >
            EXPORT
          </button>
          <button
            type="button"
            className={`btn btn-ghost${bottomPanel === "midi" || splitPanel === "midi" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("midi", event.ctrlKey || event.metaKey)}
            title="Toggle MIDI input panel"
            aria-label="Toggle MIDI input panel"
            aria-pressed={bottomPanel === "midi" || splitPanel === "midi"}
          >
            MIDI
          </button>
          <button
            type="button"
            className={`btn btn-ghost${bottomPanel === "dice" || splitPanel === "dice" ? " active" : ""}`}
            onClick={(event) => onSetBottomPanel("dice", event.ctrlKey || event.metaKey)}
            title="Toggle dice panel — rapid beat generator (Alt+6, D to roll)"
            aria-label="Toggle dice panel"
            aria-pressed={bottomPanel === "dice" || splitPanel === "dice"}
          >
            🎲 DICE
          </button>
          {onOpenPalette && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onOpenPalette}
              title="Command palette (Ctrl+K) — every action, searchable"
              aria-label="Open command palette"
            >
              ⌘K
            </button>
          )}
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
            className={`btn btn-ghost${historyOpen ? " active" : ""}`}
            onClick={onToggleHistory}
            title="Toggle undo history"
            aria-label="Toggle undo history"
            aria-pressed={historyOpen}
          >
            ↶
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const seed = nextSeed(doc.activePatternId + String(Date.now()), "topbar-vary");
              services.store.execute(assistVary(doc, doc.activePatternId, seed, 0.6));
            }}
            title="One-click vary (Ctrl+Shift+V)"
            aria-label="One-click vary"
          >
            ⚡VARY
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const seed = nextSeed(doc.activePatternId + String(Date.now()), "topbar-fill");
              services.store.execute(assistFill(doc, doc.activePatternId, seed));
            }}
            title="One-click fill (Ctrl+Shift+F)"
            aria-label="One-click fill"
          >
            FILL
          </button>
          <button
            type="button"
            className={`btn btn-ghost${assistOpen ? " active" : ""}`}
            onClick={() => {
              setAssistOpen((open) => !open);
              setCollabOpen(false);
              setScalePanelOpen(false);
            }}
            title="Iterate on the active pattern (vary / build / replace / fill)"
            aria-label="Toggle pattern assist panel"
            aria-pressed={assistOpen}
          >
            ASSIST
          </button>
          <button
            type="button"
            className={`btn btn-ghost${collabOpen ? " active" : ""}`}
            onClick={() => {
              setCollabOpen((open) => !open);
              setScalePanelOpen(false);
              setAssistOpen(false);
            }}
            title="Start or join a live jam session"
            aria-label="Toggle collaboration panel"
            aria-pressed={collabOpen}
          >
            JAM
          </button>
          <button
            type="button"
            className={`btn btn-ghost${scalePanelOpen ? " active" : ""}`}
            onClick={() => {
              setScalePanelOpen((open) => !open);
              setCollabOpen(false);
            }}
            title="Toggle scale panel (key + scale + snap)"
            aria-label="Toggle scale panel"
            aria-pressed={scalePanelOpen}
          >
            SCALE
          </button>
          <button
            type="button"
            className={`btn btn-ghost${themeOpen ? " active" : ""}`}
            onClick={() => {
              setThemeOpen((open) => !open);
              setCollabOpen(false);
              setScalePanelOpen(false);
              setAssistOpen(false);
            }}
            title="Theme — colours, size, density, motion"
            aria-label="Toggle theme panel"
            aria-pressed={themeOpen}
          >
            THEME
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
      {scalePanelOpen && (
        <div className="scale-popover">
          <ScalePanel scaleSnap={scaleSnap} onToggleSnap={onToggleScaleSnap} />
        </div>
      )}
      {collabOpen && (
        <div className="scale-popover">
          <CollabPanel onReplaceServices={onReplaceServices} />
        </div>
      )}
      {themeOpen && (
        <div className="scale-popover">
          <ThemePanel />
        </div>
      )}
      {assistOpen && (
        <div className="scale-popover">
          <AssistPanel onClose={() => setAssistOpen(false)} />
        </div>
      )}
    </>
  );
}
