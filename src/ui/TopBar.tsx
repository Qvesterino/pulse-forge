import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import {
  useActivePatternId,
  useArrangement,
  useCanRedo,
  useCanUndo,
  useLastSavedAt,
  useSaveStatus,
  useServices,
} from "./context";
import { useTransportPosition } from "./playhead";
import { DragNumber } from "./controls";
import { setBpm, setProjectName } from "../commands/commands";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { subscribePlayActivity, getLastPlayActivity } from "./playActivity";
import { pitchName } from "../project-model/types";
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
import type { BottomPanel } from "./dockLayout";

function formatClock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type TopbarAction = {
  id: string;
  label: string;
  ariaLabel: string;
  title: string;
  priority: number;
  active?: boolean;
  className?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
};

function selectTopbarActions(actions: readonly TopbarAction[], limit: number): TopbarAction[] {
  const ranked = [...actions].sort(
    (a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || b.priority - a.priority,
  );
  const selectedIds = new Set(
    ranked.slice(0, Math.max(limit, actions.filter((action) => action.active).length)).map((a) => a.id),
  );
  return actions.filter((action) => selectedIds.has(action.id));
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
  onSetBottomPanel: (panel: BottomPanel, split?: boolean) => void;
  bottomPanel: BottomPanel | null;
  splitPanel: BottomPanel | null;
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
  // Fine-grained selectors (GOAL 04): TopBar reads only the arrangement
  // (clip count badge) and the active pattern id (assist commands) from the
  // document. The full doc is still needed for the project name and BPM
  // scalars — those are plain getter reads, not subscriptions.
  const arrangement = useArrangement();
  const activePatternId = useActivePatternId();
  const doc = services.store.getDoc();
  const saveStatus = useSaveStatus();
  const lastSavedAt = useLastSavedAt();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const position = useTransportPosition(services.transport, doc);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(services.transport.loopEnabled);
  const [loopStart, setLoopStart] = useState(services.transport.loopStart);
  const [loopEnd, setLoopEnd] = useState(services.transport.loopEnd);
  // count-in / pre-roll / metronome are transport runtime state, not doc
  // state — mirror them into local state so the buttons render their actual
  // value (reading `transport.countInBars` at render time went stale).
  const [countIn, setCountIn] = useState(services.transport.countInBars);
  const [preRoll, setPreRoll] = useState(services.transport.preRollBars);
  const [metronome, setMetronome] = useState(services.transport.metronome);
  const tapTimesRef = useRef<number[]>([]);
  const [scalePanelOpen, setScalePanelOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const topbarRef = useRef<HTMLElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [topbarWidth, setTopbarWidth] = useState(1800);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Song-mode guard: pattern mode loops the active pattern, but SONG plays the
  // arrangement — audio only sounds where a clip sits under the playhead.
  // Switching mid-play from a position past the last clip looks like broken
  // audio (transport keeps running in silence), so warn instead of blocking.
  const [modeHint, setModeHint] = useState<{ text: string; offerRewind: boolean } | null>(null);
  const modeHintTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const element = topbarRef.current;
    if (!element) return;

    const updateWidth = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setTopbarWidth(width);
    };

    updateWidth();
    window.addEventListener("resize", updateWidth);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateWidth) : null;
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", updateWidth);
      observer?.disconnect();
    };
  }, []);

  // Transport is not reactive — reading `playing` at render time goes stale
  // when playback is toggled from elsewhere (Space shortcut, Esc stop…).
  // PlaybackController.notify() fires on every play/pause/stop/seek.
  const [playing, setPlaying] = useState(services.transport.playing);
  useEffect(() => {
    const unsubscribe = services.playback.subscribe(() => setPlaying(services.transport.playing));
    setPlaying(services.transport.playing);
    return unsubscribe;
  }, [services.playback, services.transport]);

  // Record arm / mode / quantize — PatternRecorder notifies on its own state.
  const recordState = useSyncExternalStore(
    services.patternRecorder.subscribe,
    services.patternRecorder.getSnapshot,
    services.patternRecorder.getSnapshot,
  );
  const recording = recordState.armed;
  const recordMode = recordState.mode;
  const recordQuantize = recordState.quantize;

  // Loop region can change from the sequencer ruler (drag) — mirror the
  // transport truth into the transport-cluster fields at low cost (rAF poll,
  // state set only on change).
  const loopRafId = useId();
  useEffect(() => {
    let last = "";
    registerRaf(loopRafId, () => {
      const t = services.transport;
      const sig = `${t.loopEnabled}|${t.loopStart}|${t.loopEnd}|${t.metronome ? 1 : 0}`;
      if (sig === last) return;
      last = sig;
      setLoopEnabled(t.loopEnabled);
      setLoopStart(t.loopStart);
      setLoopEnd(t.loopEnd);
      // Other surfaces (Hum-to-Melody) write transport.setMetronome
      // directly — without this poll the CLICK button showed a stale value.
      setMetronome(t.metronome);
    });
    return () => unregisterRaf(loopRafId);
  }, [services.transport, loopRafId]);

  // MIDI activity readout — the last performed note/pad, fading after 1.5 s.
  const playActivity = useSyncExternalStore(subscribePlayActivity, getLastPlayActivity, getLastPlayActivity);
  const [noteReadout, setNoteReadout] = useState<string | null>(null);
  useEffect(() => {
    if (!playActivity) return;
    setNoteReadout(playActivity.pitch !== undefined ? pitchName(playActivity.pitch) : "PAD");
    const t = setTimeout(() => setNoteReadout(null), 1500);
    return () => clearTimeout(t);
  }, [playActivity]);

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

  const cycleCountIn = () => {
    const next = (services.transport.countInBars + 1) % 3;
    services.transport.setCountIn(next);
    setCountIn(next);
  };

  const togglePreRoll = () => {
    const next = services.transport.preRollBars > 0 ? 0 : 1;
    services.transport.setPreRoll(next);
    setPreRoll(next);
  };

  const toggleMetronome = () => {
    const next = !services.transport.metronome;
    services.transport.setMetronome(next);
    setMetronome(next);
  };

  const clearModeHint = () => {
    if (modeHintTimerRef.current !== null) {
      clearTimeout(modeHintTimerRef.current);
      modeHintTimerRef.current = null;
    }
    setModeHint(null);
  };

  const showModeHint = (hint: { text: string; offerRewind: boolean }) => {
    if (modeHintTimerRef.current !== null) clearTimeout(modeHintTimerRef.current);
    modeHintTimerRef.current = window.setTimeout(() => {
      modeHintTimerRef.current = null;
      setModeHint(null);
    }, 6000);
    setModeHint(hint);
  };

  const togglePlayMode = () => {
    if (playMode === "pattern") {
      // barAtTick is 1-indexed, clips are 0-indexed bars.
      const playheadBar = barAtTick(Math.max(0, services.transport.position), doc);
      const barIndex = playheadBar - 1;
      const clips = arrangement.clips;
      if (clips.length === 0) {
        showModeHint({
          text: "ARRANGEMENT EMPTY — drag scenes into the timeline or hit AUTO ARRANGE",
          offerRewind: false,
        });
      } else if (!clips.some((c) => barIndex >= c.startBar && barIndex < c.startBar + c.lengthBars)) {
        showModeHint({
          text: `NO CLIP AT BAR ${playheadBar} — song mode only plays where a clip sits`,
          offerRewind: true,
        });
      } else {
        clearModeHint();
      }
    } else {
      clearModeHint();
    }
    onSetPlayMode(playMode === "pattern" ? "song" : "pattern");
  };

  // Mode can also change from outside this component (shortcuts, palette) —
  // retire the hint whenever we are not entering/holding song mode.
  useEffect(() => {
    if (playMode !== "song") clearModeHint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playMode]);
  useEffect(
    () => () => {
      if (modeHintTimerRef.current !== null) clearTimeout(modeHintTimerRef.current);
    },
    [],
  );

  /**
   * Tap tempo: average the last N taps (up to 5), 2s memory. Two taps are
   * enough to set the tempo; a rolling average keeps the read stable.
   */
  const tapTempo = () => {
    const now = Date.now();
    const taps = tapTimesRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length < 2) return;
    let sum = 0;
    for (let i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
    const avgMs = sum / (taps.length - 1);
    if (avgMs <= 0) return;
    const bpm = Math.min(300, Math.max(20, Math.round((60000 / avgMs) * 10) / 10));
    services.store.execute(setBpm(doc, bpm));
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
        // Key-repeat must not flap the loop region ~30×/s while held.
        if (event.repeat) return;
        event.preventDefault();
        toggleLoop();
      }
      // 1-klik Assist shortcuts — deterministic, no panel (repeat-guarded:
      // each press stamps a fresh seed; holding would spam undo history)
      if (!event.repeat && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        const seed = nextSeed(activePatternId + String(Date.now()), "topbar-vary");
        services.store.execute(assistVary(doc, activePatternId, seed, 0.6));
      }
      if (!event.repeat && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        const seed = nextSeed(activePatternId + String(Date.now()), "topbar-fill");
        services.store.execute(assistFill(doc, activePatternId, seed));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopEnabled, loopStart, loopEnd, doc, services.store]);

  const panelActions: TopbarAction[] = [
    {
      id: "mixer",
      label: "MIX",
      ariaLabel: "Toggle mixer panel",
      title: "Toggle mixer panel (1)",
      priority: 100,
      active: bottomPanel === "mixer" || splitPanel === "mixer",
      onClick: (event) => onSetBottomPanel("mixer", event.ctrlKey || event.metaKey),
    },
    {
      id: "devices",
      label: "DEV",
      ariaLabel: "Toggle track device chain",
      title: "Toggle the selected track's instrument and effect chain (2)",
      priority: 98,
      active: bottomPanel === "devices" || splitPanel === "devices",
      onClick: (event) => onSetBottomPanel("devices", event.ctrlKey || event.metaKey),
    },
    {
      id: "arr",
      label: "ARR",
      ariaLabel: "Toggle arrangement and scenes",
      title: "Toggle arrangement and scenes (3)",
      priority: 96,
      active: bottomPanel === "arr" || splitPanel === "arr",
      onClick: (event) => onSetBottomPanel("arr", event.ctrlKey || event.metaKey),
    },
    {
      id: "mod",
      label: "MOD",
      ariaLabel: "Toggle modulation panel",
      title: "Toggle automation, LFOs and macros (4)",
      priority: 88,
      active: bottomPanel === "mod" || splitPanel === "mod",
      onClick: (event) => onSetBottomPanel("mod", event.ctrlKey || event.metaKey),
    },
    {
      id: "exp",
      label: "EXPORT",
      ariaLabel: "Toggle export panel",
      title: "Toggle export panel (5)",
      // Below DICE/INTENT (86/84): the generative surfaces are the product's
      // differentiators and belong in direct reach; EXPORT returns to the
      // visible row on wide topbars via the higher width tier.
      priority: 78,
      active: bottomPanel === "exp" || splitPanel === "exp",
      className: "btn-export-toggle",
      onClick: (event) => onSetBottomPanel("exp", event.ctrlKey || event.metaKey),
    },
    {
      // Lives in the ⋯ overflow at common widths — the visible topbar keeps
      // the live surfaces + generative panels. The button promotes back when
      // the panel is open, so state never hides.
      id: "midi",
      label: "MIDI",
      ariaLabel: "Toggle MIDI input panel",
      title: "Toggle MIDI input panel",
      priority: 72,
      active: bottomPanel === "midi" || splitPanel === "midi",
      onClick: (event) => onSetBottomPanel("midi", event.ctrlKey || event.metaKey),
    },
    {
      // DICE/INTENT were previously reachable only via the toolbar's small
      // 🎲 button or the ⌘K palette — users could not find how to get the
      // dice panel back once the dock switched away from it (Alt+6 exists
      // but is undiscoverable). Same overflow-promote behaviour as MIDI.
      // Priority ABOVE EXPORT (86/84 > 78): the generative surfaces are the
      // product's differentiators — they get direct topbar reach at common
      // widths instead of hiding behind the ⋯ overflow.
      id: "dice",
      label: "DICE",
      ariaLabel: "Toggle dice panel",
      title: "Toggle dice panel (6) — rapid beat generator",
      priority: 86,
      active: bottomPanel === "dice" || splitPanel === "dice",
      onClick: (event) => onSetBottomPanel("dice", event.ctrlKey || event.metaKey),
    },
    {
      id: "intent",
      label: "INTENT",
      ariaLabel: "Toggle intent panel",
      title: "Toggle intent panel — describe the beat in words",
      priority: 84,
      active: bottomPanel === "intent" || splitPanel === "intent",
      onClick: (event) => onSetBottomPanel("intent", event.ctrlKey || event.metaKey),
    },
  ];

  const toolActions: TopbarAction[] = [
    ...(onOpenPalette
      ? [
          {
            id: "palette",
            label: "⌘K",
            ariaLabel: "Open command palette",
            title: "Command palette (Ctrl+K) — every action, searchable",
            priority: 100,
            onClick: () => onOpenPalette(),
          },
        ]
      : []),
    {
      id: "help",
      label: "?",
      ariaLabel: "Show keyboard shortcuts",
      title: "Show keyboard shortcuts (?)",
      priority: 94,
      onClick: onToggleHelp,
    },
    {
      id: "history",
      // Not "↶" — that glyph already means Undo in the transport cluster and
      // the duplicate read as a broken second undo button.
      label: "HIST",
      ariaLabel: "Toggle undo history",
      title: "Undo history — browse and jump to earlier states",
      priority: 86,
      active: historyOpen,
      onClick: onToggleHistory,
    },
    // One-click ⚡VARY / FILL buttons were removed from the topbar — the same
    // operations live in the ASSIST panel and on Ctrl+Shift+V / Ctrl+Shift+F.
    // The topbar should not duplicate a function the panel owns.
    {
      id: "assist",
      label: "ASSIST",
      ariaLabel: "Toggle pattern assist panel",
      title: "Iterate on the active pattern (vary / build / replace / fill)",
      priority: 70,
      active: assistOpen,
      onClick: () => {
        setAssistOpen((open) => !open);
        setCollabOpen(false);
        setScalePanelOpen(false);
      },
    },
    {
      id: "jam",
      label: "JAM",
      ariaLabel: "Toggle collaboration panel",
      title: "Start or join a live jam session",
      priority: 62,
      active: collabOpen,
      onClick: () => {
        setCollabOpen((open) => !open);
        setScalePanelOpen(false);
        setAssistOpen(false);
      },
    },
    {
      id: "scale",
      label: "SCALE",
      ariaLabel: "Toggle scale panel",
      title: "Toggle scale panel (key + scale + snap)",
      priority: 58,
      active: scalePanelOpen,
      onClick: () => {
        setScalePanelOpen((open) => !open);
        setCollabOpen(false);
      },
    },
    {
      id: "theme",
      label: "THEME",
      ariaLabel: "Toggle theme panel",
      title: "Theme — colours, size, density, motion",
      priority: 52,
      active: themeOpen,
      onClick: () => {
        setThemeOpen((open) => !open);
        setCollabOpen(false);
        setScalePanelOpen(false);
        setAssistOpen(false);
      },
    },
    {
      id: "diagnostics",
      label: "DIAG",
      ariaLabel: "Toggle diagnostics panel",
      title: "Toggle diagnostics panel",
      priority: 42,
      active: diagnosticsOpen,
      onClick: onToggleDiagnostics,
    },
  ];

  // Keep the transport and the project identity stable, then spend the remaining
  // width on actions by priority. Active panels are promoted so state never hides.
  // Panels: the four live surfaces (MIX/DEV/ARR/MOD) stay direct-access at
  // common widths — EXPORT/MIDI live in the overflow until there is room.
  // Keep the transport and the project identity stable, then spend the remaining
  // width on actions by priority. Active panels are promoted so state never hides.
  // Panels: the visible topbar keeps the four live surfaces (MIX/DEV/ARR/MOD)
  // + EXPORT; MIDI waits in the overflow. Tools cap at ⌘K/?/HIST — ASSIST,
  // JAM, SCALE, THEME and DIAG open from the ⋯ menu (or stay promoted while
  // their popover is open, so state never hides).
  // Width tiers (panel actions): at ≥1440 the generative surfaces DICE and
  // INTENT (86/84) take the 5th/6th slots ahead of EXPORT (78), which returns
  // on wide topbars (≥1760) as the 7th. MIDI stays overflow-promoted.
  const panelLimit = topbarWidth < 1120 ? 3 : topbarWidth < 1440 ? 4 : topbarWidth < 1760 ? 6 : 7;
  const toolLimit = topbarWidth < 1120 ? 2 : 3;
  const visiblePanelActions = selectTopbarActions(panelActions, panelLimit);
  const visibleToolActions = selectTopbarActions(toolActions, toolLimit);
  const overflowPanelActions = panelActions.filter((action) => !visiblePanelActions.includes(action));
  const overflowToolActions = toolActions.filter((action) => !visibleToolActions.includes(action));
  const overflowActionCount = overflowPanelActions.length + overflowToolActions.length;
  const hasOverflowActions = overflowActionCount > 0;
  // Transport terms scale with available room: full words only on wide topbars.
  // The long COUNT-IN/PRE-ROLL labels would otherwise squeeze the project name
  // and starve the rest of the bar; narrower widths keep the classic C·/PR
  // shorthands (their tooltips stay verbose at every size).
  const wideTransport = topbarWidth >= 1760;

  useEffect(() => {
    if (!hasOverflowActions) setOverflowOpen(false);
  }, [hasOverflowActions]);

  useEffect(() => {
    if (!overflowOpen) return;

    overflowMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleMenuKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOverflowOpen(false);
        overflowButtonRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

      const items = Array.from(overflowMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      if (items.length === 0) return;
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[nextIndex]?.focus();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!overflowMenuRef.current?.parentElement?.contains(event.target as Node)) setOverflowOpen(false);
    };
    window.addEventListener("keydown", handleMenuKeyDown);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", handleMenuKeyDown);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [overflowOpen]);

  const invokeOverflowAction = (action: TopbarAction, event: MouseEvent<HTMLButtonElement>) => {
    action.onClick(event);
    setOverflowOpen(false);
    overflowButtonRef.current?.focus();
  };

  return (
    <>
      <header ref={topbarRef} className="topbar">
        <div className="brand">
          <a
            href="/?landing"
            className="brand-link"
            title="Back to landing page"
            style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: 6 }}
          >
            <span className="brand-mark">KX</span>
            <span className="brand-name">KYX</span>
          </a>
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
            onClick={togglePlayMode}
            title="Toggle play mode: pattern loop or arrangement song"
          >
            {playMode === "pattern" ? "PATTERN" : "SONG"}
          </button>
          {modeHint && (
            <div className="mode-hint" role="status" aria-live="polite">
              <span className="mode-hint-text">{modeHint.text}</span>
              {modeHint.offerRewind && (
                <button
                  type="button"
                  className="mode-hint-action"
                  title="Rewind the transport to bar 1 (start of the arrangement)"
                  onClick={() => {
                    services.transport.seek(0);
                    clearModeHint();
                  }}
                >
                  REWIND
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className={`btn btn-record${recording ? " armed" : ""}`}
            onClick={() => {
              if (!services.transport.playing) {
                // FL-style record+play: arming while stopped starts playback —
                // the count-in/pre-roll applies before content begins.
                services.patternRecorder.setArmed(true);
                services.playback.playPause();
              } else {
                services.patternRecorder.setArmed(!recording);
              }
            }}
            title="Record MIDI into the active pattern — OVERDUB merges with existing steps/notes, REPLACE clears them first"
            aria-pressed={recording}
            aria-label="Record MIDI to pattern"
          >
            ⏺
          </button>
          {recording && (
            <>
              <select
                className="rec-option"
                aria-label="Record mode"
                title="OVERDUB merges performed notes into the pattern, REPLACE clears drum rows and instrument notes first"
                value={recordMode}
                onChange={(e) => services.patternRecorder.setMode(e.target.value as "overdub" | "replace")}
              >
                <option value="overdub">OVERDUB</option>
                <option value="replace">REPLACE</option>
              </select>
              <select
                className="rec-option"
                aria-label="Record quantize"
                title="Snap recorded notes to the grid (FREE keeps the performed timing)"
                value={recordQuantize}
                onChange={(e) => services.patternRecorder.setQuantize(e.target.value as "off" | "16th" | "8th")}
              >
                <option value="off">FREE</option>
                <option value="16th">Q 1/16</option>
                <option value="8th">Q 1/8</option>
              </select>
              {recordQuantize !== "off" && (
                <input
                  type="range"
                  className="rec-strength"
                  aria-label="Record quantize strength"
                  title="Quantize strength — how far notes pull toward the grid"
                  min={0}
                  max={1}
                  step={0.05}
                  value={recordState.strength}
                  onChange={(e) => services.patternRecorder.setStrength(Number(e.target.value))}
                />
              )}
            </>
          )}
          {noteReadout && (
            <span className="midi-readout" role="status" title="Last performed note / pad">
              {noteReadout}
            </span>
          )}
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
            className={`btn btn-countin${countIn > 0 ? " active" : ""}`}
            onClick={cycleCountIn}
            title="Count-in: metronome clicks 1–2 bars before playback starts (FL/Cubase pre-roll)"
            aria-label={`Count-in ${countIn > 0 ? `${countIn} bar${countIn > 1 ? "s" : ""}` : "off"}`}
          >
            {wideTransport ? "COUNT-IN" : "C·"}
            {countIn > 0 ? ` ${countIn}` : ""}
          </button>
          <button
            type="button"
            className={`btn btn-preroll${preRoll > 0 ? " active" : ""}`}
            onClick={togglePreRoll}
            title="Pre-roll: one extra click bar before the count-in (clicks only, content starts on time)"
            aria-label={preRoll > 0 ? "Pre-roll on" : "Pre-roll off"}
            aria-pressed={preRoll > 0}
          >
            {wideTransport ? "PRE-ROLL" : "PR"}
          </button>
          <button
            type="button"
            className={`btn btn-metronome${metronome ? " active" : ""}`}
            onClick={toggleMetronome}
            title="Metronome: click every beat during playback"
            aria-label={metronome ? "Metronome on" : "Metronome off"}
            aria-pressed={metronome}
          >
            CLICK
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
          <button
            type="button"
            className="btn btn-tap"
            onClick={tapTempo}
            title="Tap tempo: tap in time (2+ taps) to set the BPM"
            aria-label="Tap tempo"
          >
            TAP
          </button>
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
          {visiblePanelActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={["btn", "btn-ghost", action.className, action.active ? "active" : ""]
                .filter(Boolean)
                .join(" ")}
              onClick={action.onClick}
              title={action.title}
              aria-label={action.ariaLabel}
              aria-pressed={action.active}
            >
              {action.label}
            </button>
          ))}
          {visibleToolActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={["btn", "btn-ghost", action.active ? "active" : ""].filter(Boolean).join(" ")}
              onClick={action.onClick}
              title={action.title}
              aria-label={action.ariaLabel}
              aria-pressed={action.active}
            >
              {action.label}
            </button>
          ))}
          {hasOverflowActions && (
            <div className="topbar-overflow">
              <button
                ref={overflowButtonRef}
                type="button"
                className={`btn btn-ghost topbar-overflow-trigger${overflowOpen ? " active" : ""}`}
                onClick={() => setOverflowOpen((open) => !open)}
                title="More topbar controls"
                aria-label={`More topbar controls (${overflowActionCount} hidden)`}
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-controls="topbar-overflow-menu"
              >
                ⋯
              </button>
              {overflowOpen && (
                <div
                  ref={overflowMenuRef}
                  id="topbar-overflow-menu"
                  className="topbar-overflow-menu"
                  role="menu"
                  aria-label="More topbar controls"
                >
                  {overflowPanelActions.length > 0 && (
                    <div className="topbar-overflow-section">
                      <div className="topbar-overflow-heading">PANELS</div>
                      {overflowPanelActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className={`topbar-overflow-item${action.active ? " active" : ""}`}
                          onClick={(event) => invokeOverflowAction(action, event)}
                          title={action.title}
                          aria-label={action.ariaLabel}
                          aria-pressed={action.active}
                          role="menuitem"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {overflowToolActions.length > 0 && (
                    <div className="topbar-overflow-section">
                      <div className="topbar-overflow-heading">TOOLS</div>
                      {overflowToolActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className={`topbar-overflow-item${action.active ? " active" : ""}`}
                          onClick={(event) => invokeOverflowAction(action, event)}
                          title={action.title}
                          aria-label={action.ariaLabel}
                          aria-pressed={action.active}
                          role="menuitem"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
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
