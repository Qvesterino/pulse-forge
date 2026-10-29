import { ErrorBoundary } from "./ErrorBoundary";
import { AudioStatusChips } from "./AudioStatusChips";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import {
  useCanRedo,
  useCanUndo,
  useLastSavedAt,
  useAudibleVerification,
  useDocRevision,
  useMcpAllowDestructive,
  useMcpAllowMutations,
  useRecoveryStatus,
  useSaveStatus,
  useServices,
  useSessionRecordingState,
} from "./context";
import { useTransportPosition } from "./playhead";
import { DragNumber } from "./controls";
import { setBpm, setProjectName } from "../commands/commands";
import { registerRaf, unregisterRaf } from "../services/rafLoop";
import { subscribePlayActivity, getLastPlayActivity } from "./playActivity";
import { pitchName } from "../project-model/types";
import { barAtTick, beatAtTick } from "../project-model/schema";
import { STEP_TICKS } from "../project-model/types";
import { timelineItemsOf } from "../project-model/timeline";
import type { PlayMode } from "../project-model/types";
import type { Services } from "../services";
import { useShortcutHints } from "./useShortcutHints";
import { ScalePanel } from "./ScalePanel";
import { ThemePanel } from "./ThemePanel";
import { CollabPanel } from "./CollabPanel";
import { AssistPanel } from "./AssistPanel";
import { saveProjectAsCopy } from "../mcp/save-now";
import type { AudibleVerificationNotice } from "../analysis/audible-verification-store";

function formatClock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBandCenter(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

function audibleBadgeLabel(notice: AudibleVerificationNotice): string {
  if (!notice.verified) return "AUDIBLE ?";
  if (!notice.audibleChanged) return "AUDIBLE = unchanged";
  const parts: string[] = [];
  if (notice.lufsDelta != null && Math.abs(notice.lufsDelta) >= 0.1) {
    parts.push(`${notice.lufsDelta > 0 ? "+" : ""}${notice.lufsDelta.toFixed(1)} LU`);
  }
  if (notice.dominantBand != null && Math.abs(notice.dominantBand.deltaDb) >= 0.5) {
    parts.push(
      `${notice.dominantBand.deltaDb > 0 ? "+" : ""}${notice.dominantBand.deltaDb.toFixed(1)} dB @ ${formatBandCenter(
        notice.dominantBand.centerHz,
      )}`,
    );
  }
  return `AUDIBLE ✓ ${parts.join(" · ") || "changed"}`;
}

function hasTransportReachedContent(transport: Services["transport"]): boolean {
  // Some lightweight test adapters expose only the transport fields they use.
  // A real Transport always provides this boundary method.
  return (
    transport.playing &&
    typeof transport.anchorTickBeforePreRoll === "function" &&
    transport.position >= transport.anchorTickBeforePreRoll()
  );
}

type TopbarAction = {
  id: string;
  label: string;
  ariaLabel: string;
  title: string;
  ariaKeyshortcuts?: string;
  priority: number;
  active?: boolean;
  disabled?: boolean;
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
  ioOpen,
  onToggleIo,
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
  ioOpen: boolean;
  onToggleIo: () => void;
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
  const shortcutHints = useShortcutHints();
  // Fine-grained selectors (GOAL 04): TopBar subscribes to the active pattern
  // id used by assist commands. The full doc is still needed for project name,
  // BPM and arrangement-content checks — those are plain getter reads.
  const doc = services.store.getDoc();
  const saveStatus = useSaveStatus();
  const lastSavedAt = useLastSavedAt();
  const recoveryStatus = useRecoveryStatus();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const mcpDeleteAuthority = useMcpAllowDestructive();
  const mcpEditConsent = useMcpAllowMutations();
  const sessionRecording = useSessionRecordingState();
  const audioArmedNames = sessionRecording.armedTrackNames;
  const audioRecordingLive = sessionRecording.recState === "recording" || sessionRecording.recState === "starting";
  const agentAuthority = mcpDeleteAuthority ? "delete" : mcpEditConsent ? "edit" : "off";
  const audibleNotice = useAudibleVerification();
  const docRevision = useDocRevision();
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
  const [saveCopyOpen, setSaveCopyOpen] = useState(false);
  const [saveCopyName, setSaveCopyName] = useState("");
  const [saveCopyBusy, setSaveCopyBusy] = useState(false);
  const [saveCopyError, setSaveCopyError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!copyNotice) return;
    const id = setTimeout(() => setCopyNotice(null), 6000);
    return () => clearTimeout(id);
  }, [copyNotice]);
  const openSaveCopy = () => {
    setSaveCopyName(`${doc.name} (copy)`);
    setSaveCopyError(null);
    setSaveCopyOpen(true);
  };
  const submitSaveCopy = async () => {
    const name = saveCopyName.trim();
    if (name === "" || saveCopyBusy) return;
    setSaveCopyBusy(true);
    setSaveCopyError(null);
    try {
      const saved = await saveProjectAsCopy(services, name);
      if (!saved.ok || saved.projectId == null) {
        setSaveCopyError(saved.error ?? "the copy could not be written");
        return;
      }
      setSaveCopyOpen(false);
      setCopyNotice(`Copy saved as “${saved.name ?? name}” — the current project stays open. Find it under PROJECTS.`);
    } finally {
      setSaveCopyBusy(false);
    }
  };
  const topbarRef = useRef<HTMLElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [topbarWidth, setTopbarWidth] = useState(() => (typeof window === "undefined" ? 1200 : window.innerWidth));
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
  // `armed` is the user's intent; capture starts only when the transport has
  // crossed its count-in/pre-roll boundary. Poll that one boolean on the
  // existing shared rAF so the REC lamp changes at the actual content start.
  const [contentStarted, setContentStarted] = useState(() => {
    return hasTransportReachedContent(services.transport);
  });
  useEffect(() => {
    const syncTransportState = () => {
      const transport = services.transport;
      const nextPlaying = transport.playing;
      setPlaying(nextPlaying);
      setContentStarted(hasTransportReachedContent(transport));
    };
    const unsubscribe = services.playback.subscribe(syncTransportState);
    syncTransportState();
    return unsubscribe;
  }, [services.playback, services.transport]);

  // Record arm / mode / quantize — PatternRecorder notifies on its own state.
  const recordState = useSyncExternalStore(
    services.patternRecorder.subscribe,
    services.patternRecorder.getSnapshot,
    services.patternRecorder.getSnapshot,
  );
  const armed = recordState.armed;
  const recording = armed && playing && contentStarted;
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
      const nextContentStarted = hasTransportReachedContent(t);
      setContentStarted((current) => (current === nextContentStarted ? current : nextContentStarted));
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

  // CF-07: the pattern recorder fires this the moment REPLACE wipes the
  // active pattern (at arm, on a mode switch while armed, or on the first
  // captured hit — including from the Intent route). Silent destruction
  // during a performance reads as lost work; the disclosure names the
  // recovery — one undo takes the whole pass frame back, clear included,
  // even mid-take (ProjectStore.undo seals the open frame first).
  useEffect(() => {
    const onReplaceCleared = () => {
      showModeHint({
        text: "REPLACE cleared the pattern — one Ctrl+Z brings it back",
        offerRewind: false,
      });
    };
    window.addEventListener("pf-pattern-replace-cleared", onReplaceCleared);
    return () => window.removeEventListener("pf-pattern-replace-cleared", onReplaceCleared);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showModeHint closes over stable refs/setState only
  }, []);

  const togglePlayMode = () => {
    if (playMode === "pattern") {
      const currentDoc = services.store.getDoc();
      // barAtTick is 1-indexed, clips are 0-indexed bars.
      const playheadBar = barAtTick(Math.max(0, services.transport.position), currentDoc);
      const barIndex = playheadBar - 1;
      const timelineItems = timelineItemsOf(currentDoc);
      if (timelineItems.length === 0) {
        showModeHint({
          text: "ARRANGEMENT EMPTY — add a clip to the timeline or hit AUTO ARRANGE",
          offerRewind: false,
        });
      } else if (
        !timelineItems.some((clip) => barIndex >= clip.startBar && barIndex < clip.startBar + clip.lengthBars)
      ) {
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

  const toolActions: TopbarAction[] = [
    ...(onOpenPalette
      ? [
          {
            id: "palette",
            label: shortcutHints.label("togglePalette"),
            ariaLabel: "Open command palette",
            title: `Command palette (${shortcutHints.label("togglePalette", true)}) — every action, searchable`,
            ariaKeyshortcuts: shortcutHints.aria("togglePalette"),
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
    {
      id: "io",
      // Lives in the ⋯ overflow (promoted while open): device settings are a
      // set-and-forget surface; the statusbar meter is the primary entry.
      label: "I/O",
      ariaLabel: "Toggle Studio I/O panel",
      title: "Studio I/O — output / input devices, ASIO drivers",
      priority: 38,
      active: ioOpen,
      onClick: onToggleIo,
    },
    {
      id: "save-copy",
      // Last in the ⋯ overflow: a deliberate, low-frequency lifecycle action.
      // The dialog names the copy semantics before anything is written.
      label: "SAVE AS",
      ariaLabel: "Save a copy of this project",
      title: "Save a copy of this project under a new name — the current project stays open",
      priority: 36,
      onClick: () => openSaveCopy(),
    },
  ];

  // Keep the transport and the project identity stable, then spend the
  // remaining width on tools by priority; active tools are promoted so state
  // never hides. Tools cap at ⌘K/?/HIST — ASSIST, JAM, SCALE, THEME and DIAG
  // open from the ⋯ menu (or stay promoted while their popover is open).
  // PANEL toggles no longer live here: the bottom dock owns its own tab row
  // (DockChrome, ROADMAP-UI-2027 V1) — where the panel is, is where you
  // switch it, FL-Studio style.
  // Through 1199px keep only the core transport in the header; secondary
  // transport actions remain available in the existing overflow menu. This
  // gives the mid-width shell room to stay on one row instead of growing a
  // second chrome band.
  const compactTransport = topbarWidth < 1200;
  const toolLimit = compactTransport ? 0 : topbarWidth < 1120 ? 2 : 3;
  const visibleToolActions = compactTransport ? [] : selectTopbarActions(toolActions, toolLimit);
  const overflowToolActions = toolActions.filter((action) => !visibleToolActions.includes(action));
  const overflowTransportActions: TopbarAction[] = compactTransport
    ? [
        {
          id: "count-in",
          label: `COUNT-IN ${countIn || "OFF"}`,
          ariaLabel: `Cycle count-in (${countIn || "off"})`,
          title: "Cycle count-in: off, one bar, two bars",
          priority: 0,
          active: countIn > 0,
          onClick: () => cycleCountIn(),
        },
        {
          id: "pre-roll",
          label: `PRE-ROLL ${preRoll > 0 ? "ON" : "OFF"}`,
          ariaLabel: preRoll > 0 ? "Turn pre-roll off" : "Turn pre-roll on",
          title: "Toggle one extra click bar before count-in",
          priority: 0,
          active: preRoll > 0,
          onClick: () => togglePreRoll(),
        },
        {
          id: "metronome",
          label: `METRONOME ${metronome ? "ON" : "OFF"}`,
          ariaLabel: metronome ? "Turn metronome off" : "Turn metronome on",
          title: "Toggle the metronome during playback",
          priority: 0,
          active: metronome,
          onClick: () => toggleMetronome(),
        },
        {
          id: "loop",
          label: `LOOP ${loopEnabled ? "ON" : "OFF"}`,
          ariaLabel: loopEnabled ? "Turn loop off" : "Turn loop on",
          title: "Toggle the loop region",
          priority: 0,
          active: loopEnabled,
          onClick: () => toggleLoop(),
        },
        {
          id: "undo",
          label: "UNDO",
          ariaLabel: "Undo",
          title: `Undo (${shortcutHints.label("undo", true)})`,
          ariaKeyshortcuts: shortcutHints.aria("undo"),
          priority: 0,
          disabled: !canUndo,
          onClick: () => services.store.undo(),
        },
        {
          id: "redo",
          label: "REDO",
          ariaLabel: "Redo",
          title: `Redo (${shortcutHints.label("redo", true)})`,
          ariaKeyshortcuts: shortcutHints.aria("redo"),
          priority: 0,
          disabled: !canRedo,
          onClick: () => services.store.redo(),
        },
        {
          id: "tap-tempo",
          label: "TAP TEMPO",
          ariaLabel: "Tap tempo",
          title: "Tap twice or more to set the project tempo",
          priority: 0,
          onClick: () => tapTempo(),
        },
      ]
    : [];
  const overflowActionCount = overflowToolActions.length + overflowTransportActions.length;
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
          className={`btn btn-ghost btn-projects${topbarWidth < 720 ? " btn-projects-compact" : ""}`}
          onClick={onOpenBrowser}
          title="Back to project browser"
          aria-label="Back to project browser"
        >
          {topbarWidth < 720 ? "←" : "PROJECTS"}
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
            className={`btn btn-record${armed ? " armed" : ""}${recording ? " recording" : ""}`}
            onClick={() => {
              if (!services.transport.playing) {
                // FL-style record+play: arming while stopped starts playback —
                // the count-in/pre-roll applies before content begins.
                services.patternRecorder.setArmed(true);
                services.playback.playPause();
              } else {
                services.patternRecorder.setArmed(!armed);
              }
            }}
            title={`${recording ? "Recording MIDI" : armed ? "MIDI recording armed — waiting for content start" : "Record MIDI"} into the active pattern — OVERDUB merges with existing steps/notes, REPLACE clears them first`}
            aria-pressed={recording}
            aria-label={
              recording
                ? "MIDI recording active"
                : armed
                  ? "MIDI recording armed; waiting for playback"
                  : "Record MIDI to pattern"
            }
          >
            <span aria-hidden="true">⏺</span>
            <span className="rec-target-label" aria-hidden="true">
              MIDI
            </span>
          </button>
          {audioArmedNames.length > 0 && (
            <span
              className={`rec-audio-armed${audioRecordingLive ? " live" : ""}`}
              role="status"
              title={`AUDIO recording ${audioRecordingLive ? "is live" : "is armed"} on ${audioArmedNames.join(
                ", ",
              )}. Press ● AUDIO REC in the ARRANGEMENT panel — this MIDI button records the active pattern.`}
            >
              {audioRecordingLive ? "AUDIO REC" : "AUDIO ARMED"}
            </span>
          )}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {recording
              ? "MIDI recording is active."
              : armed
                ? "MIDI recording is armed and waiting for playback content to begin."
                : ""}
          </span>
          {armed && (
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
            title={`Play / Pause (${shortcutHints.label("playPause")})`}
            aria-keyshortcuts={shortcutHints.aria("playPause")}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="btn btn-stop" onClick={() => services.playback.stop()} title="Stop">
            ■
          </button>
          {!compactTransport && (
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
          )}
          {!compactTransport && (
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
          )}
          {!compactTransport && (
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
          )}
          {!compactTransport && (
            <button
              type="button"
              className="btn btn-history"
              disabled={!canUndo}
              onClick={() => services.store.undo()}
              title={`Undo (${shortcutHints.label("undo", true)})`}
              aria-label="Undo"
              aria-keyshortcuts={shortcutHints.aria("undo")}
            >
              ↶
            </button>
          )}
          {!compactTransport && (
            <button
              type="button"
              className="btn btn-history"
              disabled={!canRedo}
              onClick={() => services.store.redo()}
              title={`Redo (${shortcutHints.label("redo", true)})`}
              aria-label="Redo"
              aria-keyshortcuts={shortcutHints.aria("redo")}
            >
              ↷
            </button>
          )}
          {(!compactTransport || topbarWidth > 760) && <span className="position-display">{position}</span>}
          {!compactTransport && (
            <button
              type="button"
              className={`btn btn-loop${loopEnabled ? " active" : ""}`}
              onClick={toggleLoop}
              title={`Toggle loop region (${shortcutHints.label("toggleLoop")}). IN/OUT locators also define a single-pass punch range when LOOP is off.`}
              aria-label="Toggle loop region"
              aria-keyshortcuts={shortcutHints.aria("toggleLoop")}
              aria-pressed={loopEnabled}
            >
              LOOP
            </button>
          )}
          {(loopEnabled || loopEnd > loopStart) && (
            <>
              <DragNumber
                label="IN"
                hint="Loop start locator (bar.beat) — playback wraps here; doubles as the punch-in point for punch recording"
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
                hint="Loop end locator (bar.beat) — playback wraps here; punch recording trims the take at this exact frame"
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
            hint="Project tempo in beats per minute (20–300) — drives the scheduler, pattern length and every export"
            value={doc.bpm}
            min={20}
            max={300}
            defaultValue={124}
            sensitivity={0.4}
            format={(v) => v.toFixed(1)}
            onCommit={(bpm) => services.store.execute(setBpm(doc, bpm))}
          />
          {!compactTransport && (
            <button
              type="button"
              className="btn btn-tap"
              onClick={tapTempo}
              title="Tap tempo: tap in time (2+ taps) to set the BPM"
              aria-label="Tap tempo"
            >
              TAP
            </button>
          )}
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
          <AudioStatusChips />
          <span
            className={`save-status save-${saveStatus}`}
            title={
              saveStatus === "saved"
                ? `All changes saved${lastSavedAt ? ` at ${formatClock(lastSavedAt)}` : ""}. Autosave is on.`
                : saveStatus === "dirty"
                  ? `Unsaved changes — autosave runs in a moment (${shortcutHints.label("save", true)} to save now)`
                  : saveStatus === "saving"
                    ? "Saving…"
                    : "Save failed — click to retry"
            }
            role={saveStatus === "error" ? "button" : "status"}
            aria-live="polite"
            aria-label={saveStatus === "error" ? "Save failed. Retry saving project." : undefined}
            aria-keyshortcuts={saveStatus === "error" ? "Enter Space" : undefined}
            tabIndex={saveStatus === "error" ? 0 : undefined}
            onClick={saveStatus === "error" ? () => void services.flushSave() : undefined}
            onKeyDown={
              saveStatus === "error"
                ? (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    void services.flushSave();
                  }
                : undefined
            }
          >
            {saveStatus === "saved" && `SAVED${lastSavedAt ? ` ${formatClock(lastSavedAt)}` : ""}`}
            {saveStatus === "dirty" && "UNSAVED"}
            {saveStatus === "saving" && "SAVING…"}
            {saveStatus === "error" && "SAVE ERROR — RETRY"}
          </span>
          {/* Audit S-4: the crash buffer is the only copy of the work that was
              uncommitted when the tab dies. When it cannot hold this project,
              the user has to know WHILE they can still save — not after the
              session is gone. The chip sits next to the save status because
              that is where "is my work safe" is already answered. */}
          {recoveryStatus === "unprotected" && (
            <span
              className="save-status save-unprotected"
              role="status"
              aria-live="polite"
              title="The crash buffer cannot hold this project: if the tab closes now, the uncommitted work cannot be recovered. Save often."
            >
              NOT CRASH-PROTECTED
            </span>
          )}
          {/* F-05: agent authority must be visible from EVERY panel, not only
              while the INTENT panel happens to be open. The badge reads the
              same store as the toggles, so it cannot drift or stay stale. */}
          {agentAuthority !== "off" && (
            <span
              className={`agent-authority-badge ${agentAuthority}`}
              role="status"
              aria-live="polite"
              title={
                agentAuthority === "delete"
                  ? "External MCP clients may DELETE tracks, sections and FX. Turn it off in INTENT → MCP (MAZANIE)."
                  : "External MCP clients may EDIT this project. Turn it off in INTENT → MCP (ZMENY)."
              }
            >
              {agentAuthority === "delete" ? "AGENT DELETE ON" : "AGENT EDIT ON"}
            </span>
          )}
          {audibleNotice != null &&
            audibleNotice.docId === doc.id &&
            (audibleNotice.revision == null || docRevision == null || audibleNotice.revision === docRevision) && (
              <span
                className={`audible-verification-badge${audibleNotice.audibleChanged ? " changed" : " unchanged"}`}
                role="status"
                aria-live="polite"
                title={`${audibleNotice.scopeLabel} — ${
                  audibleNotice.verified
                    ? audibleNotice.audibleChanged
                      ? "the rendered audio changed"
                      : "the rendered audio is unchanged"
                    : "the comparison was inconclusive"
                }; null residual ${audibleNotice.nullResidualDb ?? "n/a"} dB; revision ${
                  audibleNotice.revision ?? "unknown"
                }.`}
              >
                {audibleBadgeLabel(audibleNotice)}
              </span>
            )}
          {visibleToolActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={["btn", "btn-ghost", action.active ? "active" : ""].filter(Boolean).join(" ")}
              onClick={action.onClick}
              title={action.title}
              aria-label={action.ariaLabel}
              aria-keyshortcuts={action.ariaKeyshortcuts}
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
                className={`btn btn-ghost topbar-overflow-trigger${overflowOpen || overflowToolActions.some((action) => action.active) || overflowTransportActions.some((action) => action.active) ? " active" : ""}`}
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
                          aria-keyshortcuts={action.ariaKeyshortcuts}
                          aria-pressed={action.active}
                          disabled={action.disabled}
                          role="menuitem"
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {overflowTransportActions.length > 0 && (
                    <div className="topbar-overflow-section">
                      <div className="topbar-overflow-heading">TRANSPORT</div>
                      {overflowTransportActions.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          className={`topbar-overflow-item${action.active ? " active" : ""}`}
                          onClick={(event) => invokeOverflowAction(action, event)}
                          title={action.title}
                          aria-label={action.ariaLabel}
                          aria-keyshortcuts={action.ariaKeyshortcuts}
                          aria-pressed={action.active}
                          disabled={action.disabled}
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
          <ErrorBoundary panel="scale-panel">
            <ScalePanel scaleSnap={scaleSnap} onToggleSnap={onToggleScaleSnap} />
          </ErrorBoundary>
        </div>
      )}
      {collabOpen && (
        <div className="scale-popover">
          <ErrorBoundary panel="collab">
            <CollabPanel onReplaceServices={onReplaceServices} />
          </ErrorBoundary>
        </div>
      )}
      {themeOpen && (
        <div className="scale-popover">
          <ErrorBoundary panel="theme">
            <ThemePanel />
          </ErrorBoundary>
        </div>
      )}
      {assistOpen && (
        <div className="scale-popover">
          <ErrorBoundary panel="assist">
            <AssistPanel onClose={() => setAssistOpen(false)} />
          </ErrorBoundary>
        </div>
      )}
      {saveCopyOpen && (
        <div
          role="presentation"
          style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.45)" }}
          onClick={() => {
            if (!saveCopyBusy) setSaveCopyOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Save a copy of this project"
            style={{
              position: "fixed",
              top: "72px",
              left: "50%",
              transform: "translateX(-50%)",
              minWidth: 340,
              maxWidth: "90vw",
              padding: 16,
              background: "var(--bg-panel, #12141a)",
              border: "1px solid var(--border, #2a2e37)",
              borderRadius: 8,
              boxShadow: "0 12px 32px rgba(0,0,0,0.48)",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitSaveCopy();
              }}
            >
              <label
                htmlFor="save-copy-name"
                style={{ display: "block", fontWeight: 700, fontSize: 12, marginBottom: 6 }}
              >
                SAVE A COPY
              </label>
              <input
                id="save-copy-name"
                autoFocus
                value={saveCopyName}
                maxLength={120}
                disabled={saveCopyBusy}
                aria-describedby="save-copy-hint"
                onChange={(event) => setSaveCopyName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !saveCopyBusy) {
                    event.stopPropagation();
                    setSaveCopyOpen(false);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  background: "var(--bg, #0b0c10)",
                  border: "1px solid var(--border, #2a2e37)",
                  borderRadius: 4,
                  color: "var(--text, #d9dbe1)",
                }}
              />
              <p id="save-copy-hint" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--text-dim, #8d94a2)" }}>
                Writes a NEW project record under this name. The current project keeps its name and stays open — this is
                save-as-copy, not a switch.
              </p>
              {saveCopyError && (
                <p role="alert" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--stop, #f87171)" }}>
                  {saveCopyError}
                </p>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={saveCopyBusy}
                  onClick={() => setSaveCopyOpen(false)}
                >
                  CANCEL
                </button>
                <button type="submit" className="btn btn-primary" disabled={saveCopyBusy || saveCopyName.trim() === ""}>
                  {saveCopyBusy ? "SAVING…" : "SAVE COPY"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {copyNotice && (
        <div className="arr-delete-toast" role="status">
          <span>{copyNotice}</span>
        </div>
      )}
    </>
  );
}
