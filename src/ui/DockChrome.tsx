import type { KeyboardEvent, PointerEvent } from "react";
import type { BottomPanel, DockState } from "./dockLayout";

/**
 * Bottom dock chrome — the always-visible tab strip + resize grip
 * (ROADMAP-UI-2027, Vlna 1).
 *
 * FL-Studio lesson this encodes: a panel system is only intuitive while its
 * switches are ALWAYS on screen. The tab row never unmounts — a collapsed
 * dock IS the tab row, not a 7px invisible strip — so opening any panel is
 * one click from anywhere, in any dock state.
 *
 * Plain click toggles the panel's visibility in whichever slot hosts it
 * (see `togglePanelVisible` in dockLayout.ts); Ctrl/Cmd+click manages the
 * split slot (toggleSlot slot 1).
 */

export interface DockTabDef {
  id: BottomPanel;
  label: string;
  /** Stable a11y name — e2e specs target these strings. */
  ariaLabel: string;
  title: string;
}

/** Tab order mirrors the workflow: the core four, the generative pair (the
 * product's differentiators), then utilities. PANEL_KEYS in dockLayout.ts
 * stays the panel REGISTRY; this array only orders and labels it — the
 * DockChrome test pins the two together so a new panel can never ship
 * without a tab. */
export const DOCK_TABS: readonly DockTabDef[] = [
  { id: "mixer", label: "MIX", ariaLabel: "Toggle mixer panel", title: "Mixer — levels, sends, groups (Alt+1)" },
  {
    id: "devices",
    label: "DEV",
    ariaLabel: "Toggle track device chain",
    title: "Instrument + effect chain of the selected track (Alt+2)",
  },
  {
    id: "arr",
    label: "ARR",
    ariaLabel: "Toggle arrangement and scenes",
    title: "Arrangement timeline and scenes (Alt+3)",
  },
  { id: "mod", label: "MOD", ariaLabel: "Toggle modulation panel", title: "Automation, LFOs and macros (Alt+4)" },
  { id: "dice", label: "DICE", ariaLabel: "Toggle dice panel", title: "Dice — rapid beat generator (Alt+6)" },
  { id: "intent", label: "INTENT", ariaLabel: "Toggle intent panel", title: "Describe the beat in words (Alt+7)" },
  { id: "exp", label: "EXP", ariaLabel: "Toggle export panel", title: "Export audio and project (Alt+5)" },
  {
    id: "master",
    label: "MASTER",
    ariaLabel: "Toggle mastering panel",
    title: "Mastering — final processing, loudness targets and stereo checks (Alt+9)",
  },
  { id: "midi", label: "MIDI", ariaLabel: "Toggle MIDI input panel", title: "MIDI input and routing (Alt+8)" },
  {
    id: "reference",
    label: "REF",
    ariaLabel: "Toggle reference map panel",
    title: "Reference map — BPM, key and confidence of a finished track",
  },
];

interface DockChromeProps {
  dock: DockState;
  /** Tab click: `split` is true for Ctrl/Cmd+click. */
  onToggle: (panel: BottomPanel, split: boolean) => void;
  onCloseAll: () => void;
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
  /** Double-click / Enter on the grip: back to the viewport default. */
  onResizeReset: () => void;
  /** Keyboard resize from the focused grip: ±16 px per press. */
  onResizeStep: (deltaPx: number) => void;
}

export function DockChrome({
  dock,
  onToggle,
  onCloseAll,
  onResizeStart,
  onResizeReset,
  onResizeStep,
}: DockChromeProps) {
  const anyOpen = dock.slotA !== null || dock.slotB !== null;
  const onGripKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onResizeStep(16);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onResizeStep(-16);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onResizeReset();
    }
  };
  return (
    <div className="dock-chrome">
      <button
        type="button"
        className="dock-resize-handle"
        aria-label="Resize bottom panel dock"
        title="Drag to resize · double-click to reset · ↑/↓ when focused"
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        onKeyDown={onGripKeyDown}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </button>
      <div className="dock-tabs" role="tablist" aria-label="Bottom dock panels">
        {DOCK_TABS.map((tab) => {
          const inA = dock.slotA === tab.id;
          const inB = dock.slotB === tab.id;
          const open = inA || inB;
          return (
            <button
              key={tab.id}
              type="button"
              id={`dock-tab-${tab.id}`}
              role="tab"
              aria-label={tab.ariaLabel}
              aria-selected={open}
              aria-controls={`dock-panel-${tab.id}`}
              className={"dock-tab" + (open ? " active" : "") + (inB ? " in-split" : "")}
              onClick={(event) => onToggle(tab.id, event.ctrlKey || event.metaKey)}
              title={tab.title}
            >
              <span className="dock-tab-led" aria-hidden="true" />
              <span className="dock-tab-label">{tab.label}</span>
            </button>
          );
        })}
        <div className="dock-tabs-actions">
          {dock.slotB !== null && (
            <span className="dock-split-badge" title="Split view on — Ctrl+click a tab to move panels between slots">
              SPLIT
            </span>
          )}
          <button
            type="button"
            className="dock-close-all"
            onClick={onCloseAll}
            disabled={!anyOpen}
            aria-label="Close all dock panels"
            title="Close all panels — the dock stays as this tab bar"
          >
            ▾
          </button>
        </div>
      </div>
    </div>
  );
}
