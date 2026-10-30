import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { BottomPanel, DockState } from "./dockLayout";
import type { ShortcutKey } from "./shortcuts";
import { useShortcutHints } from "./useShortcutHints";

/**
 * CF-22 — dock focus keeper. The panel inside a slot unmounts when its tab
 * toggles it off (or the slot swaps), and a focused element removed from the
 * DOM drops focus to <body>: the keyboard user loses their place and the
 * next Tab starts from the document top. The cleanup defers one turn, then
 * — only if focus is still orphaned — hands it back to the panel's OWN dock
 * tab: always mounted (the strip never unmounts), and the very switch that
 * closed the panel. A tab CLICK already focuses the tab in the browser, so
 * the pointer path is untouched; the restore fires for the keyboard and
 * programmatic closes that used to leak.
 */
export function DockSlotFocusBoundary({ panelId, children }: { panelId: BottomPanel; children: ReactNode }) {
  useEffect(() => {
    return () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        const orphaned = !active || active === document.body || active === document.documentElement;
        if (!orphaned) return;
        document.querySelector<HTMLElement>(`[data-dock-tab="${panelId}"]`)?.focus();
      }, 0);
    };
  }, [panelId]);
  return <>{children}</>;
}

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
  shortcut?: ShortcutKey;
}

/** Tab order mirrors the workflow: the core four, the generative pair (the
 * product's differentiators), then utilities. PANEL_KEYS in dockLayout.ts
 * stays the panel REGISTRY; this array only orders and labels it — the
 * DockChrome test pins the two together so a new panel can never ship
 * without a tab. */
export const DOCK_TABS: readonly DockTabDef[] = [
  {
    id: "mixer",
    label: "MIX",
    ariaLabel: "Toggle mixer panel",
    title: "Mixer — levels, sends, groups",
    shortcut: "panelMix",
  },
  {
    id: "devices",
    label: "DEV",
    ariaLabel: "Toggle track device chain",
    title: "Instrument + effect chain of the selected track",
    shortcut: "panelFx",
  },
  {
    id: "tsar",
    label: "TSAR",
    ariaLabel: "Toggle TSAR engine panel",
    title: "TSAR - hybrid sample + synthesis engine: dual sources, morph, mod matrix, Forge",
    shortcut: "panelTsar",
  },
  {
    id: "choral",
    label: "CHO",
    ariaLabel: "Toggle Chorál panel",
    title: "Chorál — drop-a-hum choir: grain stack, formant shaping and Forge root estimate",
  },
  {
    id: "kopa",
    label: "KOPA",
    ariaLabel: "Toggle KOPA panel",
    title: "KOPA — kick designer: reference Forge, pitch/click/body/tail, LOW-END STACK",
  },
  {
    id: "arr",
    label: "ARR",
    ariaLabel: "Toggle arrangement and scenes",
    title: "Arrangement timeline and scenes",
    shortcut: "panelArr",
  },
  {
    id: "live",
    label: "LIVE",
    ariaLabel: "Toggle Live Pads",
    title: "Live Pads — save loop sets and launch loops into the song arrangement",
  },
  {
    id: "mod",
    label: "MOD",
    ariaLabel: "Toggle modulation panel",
    title: "Automation, LFOs and macros",
    shortcut: "panelMod",
  },
  {
    id: "dice",
    label: "DICE",
    ariaLabel: "Toggle dice panel",
    title: "Dice — rapid beat generator",
    shortcut: "panelDice",
  },
  {
    id: "intent",
    label: "INTENT",
    ariaLabel: "Toggle intent panel",
    title: "Describe the beat in words",
    shortcut: "panelIntent",
  },
  {
    id: "exp",
    label: "EXP",
    ariaLabel: "Toggle export panel",
    title: "Export audio and project",
    shortcut: "panelExport",
  },
  {
    id: "master",
    label: "MASTER",
    ariaLabel: "Toggle mastering panel",
    title: "Mastering — final processing, loudness targets and stereo checks",
    shortcut: "panelMaster",
  },
  {
    id: "midi",
    label: "MIDI",
    ariaLabel: "Toggle MIDI input panel",
    title: "MIDI input and routing",
    shortcut: "panelMidi",
  },
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
  const shortcutHints = useShortcutHints();
  const anyOpen = dock.slotA !== null || dock.slotB !== null;
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabScrollEdges, setTabScrollEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const selectedPanel = dock.slotB ?? dock.slotA;

    const updateScrollEdges = () => {
      const maxScroll = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
      const left = tabs.scrollLeft > 1;
      const right = tabs.scrollLeft < maxScroll - 1;
      setTabScrollEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
    };

    const revealSelectedTab = () => {
      if (!selectedPanel) return;
      const selectedTab = tabs.querySelector<HTMLButtonElement>(`[data-dock-tab="${selectedPanel}"]`);
      if (selectedTab && typeof selectedTab.scrollIntoView === "function") {
        selectedTab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };

    revealSelectedTab();
    updateScrollEdges();
    tabs.addEventListener("scroll", updateScrollEdges, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updateScrollEdges();
            revealSelectedTab();
          });
    observer?.observe(tabs);
    tabs.querySelectorAll(".dock-tab").forEach((tab) => observer?.observe(tab));
    return () => {
      tabs.removeEventListener("scroll", updateScrollEdges);
      observer?.disconnect();
    };
  }, [dock.slotA, dock.slotB]);

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
      <div
        className={
          "dock-tabs" + (tabScrollEdges.left ? " has-more-left" : "") + (tabScrollEdges.right ? " has-more-right" : "")
        }
        role="group"
        aria-label="Bottom dock panels"
        ref={tabsRef}
      >
        {DOCK_TABS.map((tab) => {
          const inA = dock.slotA === tab.id;
          const inB = dock.slotB === tab.id;
          const open = inA || inB;
          return (
            <button
              key={tab.id}
              type="button"
              id={`dock-tab-${tab.id}`}
              aria-label={tab.ariaLabel}
              aria-expanded={open}
              aria-controls={open ? `dock-panel-${tab.id}` : undefined}
              data-dock-tab={tab.id}
              className={"dock-tab" + (open ? " active" : "") + (inB ? " in-split" : "")}
              onClick={(event) => onToggle(tab.id, event.ctrlKey || event.metaKey)}
              title={tab.shortcut ? `${tab.title} (${shortcutHints.label(tab.shortcut)})` : tab.title}
              aria-keyshortcuts={tab.shortcut ? shortcutHints.aria(tab.shortcut) : undefined}
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
