import { useEffect, useRef, useState } from "react";
import { useDoc, useServices } from "./context";
import type { DrumTrack } from "../project-model/types";
import { usePlayheadStep } from "./playhead";
import { assetCategoryOf, categoryColor } from "./kitColors";
import { FALLOFF_MODES, REPEAT_RATES, type FalloffMode, type RepeatRate } from "../audio-engine/NoteRepeat";
import {
  applyKitToDrumTrack,
  captureKitFromTrack,
  captureSketchFromDoc,
  installPackSketch,
  setPadColor,
} from "../commands/commands";
import { decodeBindsCode, encodeBindsCode } from "../export/bindsCode";
import { decodePackCode, encodePackCode, type SharedPack } from "../export/packCode";
import { GroovePoolRepository } from "../persistence/GroovePoolRepository";
import { getThemeSnapshot, setTheme } from "./theme";
import { decodeKitCode, encodeKitCode } from "../export/kitCode";
import type { UserKit } from "../persistence/KitRepository";

import { bindPadKey, getPadKeys, importPadKeys, isPadKey, resetPadKeys, usePadKeys } from "./padKeys";

const PAD_COLOR_SWATCHES = [
  "#f59e0b",
  "#f87171",
  "#fb7185",
  "#f472b6",
  "#a78bfa",
  "#60a5fa",
  "#22d3ee",
  "#4ade80",
  "#a3e635",
  "#e8e8e8",
];

/** Divisions a pad can pin individually (global "off" is the master switch, not an option here). */
const PINNABLE_RATES = ["1/4", "1/8", "1/16", "1/8T", "1/16T"] as const;
type PinnableRate = (typeof PINNABLE_RATES)[number];

/** A pad's pinned rate wins; otherwise the global default. (A function breaks TS's const alias-narrowing, which otherwise types this as PinnableRate.) */
function effectiveRateOf(pinned: RepeatRate | undefined, globalRate: RepeatRate): RepeatRate {
  return pinned ?? globalRate;
}

export function RackStrip({
  track,
  selectedPadId,
  onSelectPad,
}: {
  track: DrumTrack;
  selectedPadId: string;
  onSelectPad: (padId: string) => void;
}) {
  const services = useServices();
  const doc = useDoc();
  const pattern = doc.patterns.find((p) => p.id === doc.activePatternId)!;
  const playheadStep = usePlayheadStep(services.transport, doc);
  const [repeatRate, setRepeatRate] = useState<RepeatRate>("off");
  const [falloff, setFalloff] = useState<FalloffMode>("decay");
  /** Per-pad pinned divisions — kick can roll 1/16 while the hat rolls 1/8T. */
  const [pinnedRates, setPinnedRates] = useState<Record<string, PinnableRate>>({});
  const [rateMenu, setRateMenu] = useState<{ padId: string; x: number; y: number } | null>(null);
  /** MPC 16 LEVELS: pads become velocity lanes for the selected sound. */
  const [sixteenLevels, setSixteenLevels] = useState(false);
  const padKeys = usePadKeys();
  const [keysMenu, setKeysMenu] = useState<{ x: number; y: number } | null>(null);
  const [captureIndex, setCaptureIndex] = useState<number | null>(null);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [kitMenu, setKitMenu] = useState<{ x: number; y: number } | null>(null);
  const [userKits, setUserKits] = useState<UserKit[]>([]);
  const [kitStatus, setKitStatus] = useState<string | null>(null);

  // Refresh the user kit list whenever the kit menu opens.
  useEffect(() => {
    if (!kitMenu) return;
    void services.userKits.list().then(setUserKits);
  }, [kitMenu, services]);

  // Close the per-pad rate menu on any outside press (same contract as the
  // arrangement context menus).
  useEffect(() => {
    if (!rateMenu) return;
    const close = () => setRateMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [rateMenu]);
  useEffect(() => {
    if (!kitMenu) return;
    const close = () => setKitMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [kitMenu]);

  // While a key slot is "capturing", the next keydown binds it (swap on clash).
  useEffect(() => {
    if (captureIndex === null) return;
    const onCapture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCaptureIndex(null);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key.length !== 1) return;
      bindPadKey(captureIndex, key);
      setCaptureIndex(null);
      setKeyStatus(`Bound '${key.toUpperCase()}' to pad ${captureIndex + 1}`);
    };
    window.addEventListener("keydown", onCapture, true);
    return () => window.removeEventListener("keydown", onCapture, true);
  }, [captureIndex]);

  const triggerPad = (padId: string) => {
    const pad = track.pads.find((p) => p.id === padId);
    if (pad) {
      services.engine.preview(pad, track.id);
      const peak = pad.gain;
      setPeaks((prev) => ({ ...prev, [padId]: peak }));
    }
  };

  const padKeyOf = (padId: string) => `pad:${track.id}:${padId}`;

  /**
   * Pad-down via pointer/QWERTY: one immediate hit, repeats while held when
   * armed. In 16 LEVELS mode every pad plays the SELECTED pad's sound at a
   * fixed velocity by position (MPC style) — selection stays locked.
   */
  const padDown = (padId: string, holdKey: string) => {
    const physicalIndex = track.pads.findIndex((p) => p.id === padId);
    if (physicalIndex < 0) return;
    const levels = sixteenLevels && selectedPadId;
    const targetPadId = levels ? selectedPadId : padId;
    const baseVelocity = levels ? (physicalIndex + 1) / track.pads.length : 1;
    const pad = track.pads.find((p) => p.id === targetPadId);
    if (!pad) return;
    services.noteRepeat.start(holdKey, track.id, targetPadId, baseVelocity, pinnedRates[targetPadId]);
    setPeaks((prev) => ({ ...prev, [targetPadId]: pad.gain * baseVelocity }));
  };

  const padUp = (holdKey: string) => {
    services.noteRepeat.stop(holdKey);
  };

  // QWERTY pad play: hold a key to trigger (and repeat when armed). Keys are
  // user-rebindable (AZERTY/SK layouts) and shadow plain-letter shortcuts.
  useEffect(() => {
    const padByKey = new Map<string, string>();
    track.pads.forEach((pad, index) => {
      if (index < padKeys.length && padKeys[index]) padByKey.set(padKeys[index], pad.id);
    });
    const isTypingTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const padId = padByKey.get(key);
      if (!padId || isPadKey(key) === false) return;
      if (isPadKey(key)) event.preventDefault();
      padDown(padId, `key:${key}`);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const padId = padByKey.get(key);
      if (!padId) return;
      if (isPadKey(key)) padUp(`key:${key}`);
    };
    const onBlur = () => {
      services.noteRepeat.stopAll();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      services.noteRepeat.stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, track.pads, services.noteRepeat, padKeys]);

  const [peaks, setPeaks] = useState<Record<string, number>>({});
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;

  // Decay peaks 60fps
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, v] of Object.entries(peaksRef.current)) {
        const nv = v * 0.88;
        if (nv > 0.02) {
          next[id] = nv;
          changed = true;
        } else changed = true;
      }
      if (changed) setPeaks(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Playhead hit → peak from pattern velocity * pad gain
  const prevStepRef = useRef<number>(-1);
  useEffect(() => {
    if (playheadStep < 0 || prevStepRef.current === playheadStep) return;
    prevStepRef.current = playheadStep;
    for (const pad of track.pads) {
      const vel = pattern.rows[pad.id]?.[playheadStep] ?? 0;
      if (vel > 0 && !pad.mute && !track.mute) {
        const peak = Math.min(1.2, vel * pad.gain);
        setPeaks((prev) => ({ ...prev, [pad.id]: peak }));
      }
    }
  }, [playheadStep, pattern.rows, track.pads, track.mute]);

  // ── User kits ──────────────────────────────────────────────────────────

  const saveCurrentKit = () => {
    const fallback = `Kit ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const name = window.prompt("Kit name", fallback);
    if (!name) return;
    const kit: UserKit = {
      id: `ukit-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      name,
      genre: "custom",
      description: "",
      pads: captureKitFromTrack(doc, track.id),
      createdAt: new Date().toISOString(),
    };
    void services.userKits
      .save(kit)
      .then(() => services.userKits.list())
      .then(setUserKits);
    setKitStatus(`Saved "${name}"`);
  };

  const applyKit = (kit: UserKit) => {
    try {
      services.store.execute(applyKitToDrumTrack(doc, track.id, kit.name, kit.pads));
      setKitStatus(`Applied "${kit.name}" — ${kit.pads.length} pads`);
    } catch (err) {
      setKitStatus(err instanceof Error ? err.message : "Apply failed");
    }
  };

  const deleteKit = (kit: UserKit) => {
    void services.userKits
      .remove(kit.id)
      .then(() => services.userKits.list())
      .then(setUserKits);
    setKitStatus(`Deleted "${kit.name}"`);
  };

  const copyKitCode = async (kit: UserKit) => {
    try {
      await navigator.clipboard.writeText(encodeKitCode(kit.name, kit.pads));
      setKitStatus(`Code for "${kit.name}" copied — paste it into any KYX`);
    } catch {
      setKitStatus("Clipboard blocked by the browser");
    }
  };

  const installFromCode = () => {
    const code = window.prompt("Paste a KYX kit code (PFKIT1:…)");
    if (!code) return;
    const kit = decodeKitCode(code);
    if (!kit) {
      setKitStatus("Invalid kit code");
      return;
    }
    const userKit: UserKit = {
      id: `ukit-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: kit.name,
      genre: "shared",
      description: "Installed from a kit code",
      pads: kit.pads,
      createdAt: new Date().toISOString(),
    };
    void services.userKits
      .save(userKit)
      .then(() => services.userKits.list())
      .then(setUserKits);
    setKitStatus(`Installed "${kit.name}"`);
  };

  const copyPackCode = async () => {
    try {
      const kitPads = captureKitFromTrack(doc, track.id);
      let grooves: SharedPack["grooves"];
      try {
        const pool = await new GroovePoolRepository().list();
        grooves = pool.slice(0, 8).map((g) => ({ name: g.name, timing: g.timing, accent: g.accent }));
      } catch {
        grooves = undefined;
      }
      const sketch = captureSketchFromDoc(doc, track.id);
      const code = encodePackCode({
        kitName: `${track.name} Pack`,
        kitPads,
        binds: getPadKeys(),
        theme: getThemeSnapshot(),
        grooves,
        sketch,
      });
      await navigator.clipboard.writeText(code);
      const parts = [
        "kit",
        "keys",
        "theme",
        grooves?.length ? `${grooves.length} groove${grooves.length > 1 ? "s" : ""}` : null,
        sketch ? `${sketch.scenes.length} scenes` : null,
      ].filter(Boolean);
      setKitStatus(`PACK copied — ${parts.join(" + ")}`);
    } catch {
      setKitStatus("Clipboard blocked by the browser");
    }
  };

  const installPackCode = () => {
    const code = window.prompt("Paste a KYX PACK code (PFPACK1:…)");
    if (!code) return;
    const pack = decodePackCode(code);
    if (!pack) {
      setKitStatus("Invalid PACK code");
      return;
    }
    if (pack.binds) importPadKeys(pack.binds);
    if (pack.theme) setTheme(pack.theme);
    if (pack.grooves?.length) {
      const repo = new GroovePoolRepository();
      void Promise.all(
        pack.grooves.map((g) =>
          repo.save({
            id: `groove-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            name: g.name,
            timing: g.timing,
            accent: g.accent,
            createdAt: new Date().toISOString(),
          }),
        ),
      ).catch(() => undefined);
    }
    if (pack.kitPads && pack.kitName) {
      const userKit: UserKit = {
        id: `ukit-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        name: pack.kitName,
        genre: "shared",
        description: "Installed from a PACK code",
        pads: pack.kitPads,
        createdAt: new Date().toISOString(),
      };
      // Without the catch, an IndexedDB failure (quota, private mode) left a
      // half-installed pack behind AND an unhandled promise rejection.
      services.userKits
        .save(userKit)
        .then(() => services.userKits.list())
        .then(setUserKits)
        .catch((err) => {
          console.error("[pack] kit save failed:", err);
          setKitStatus("Pack installed — but saving the kit failed (storage)");
        });
    }
    let installedScenes = 0;
    if (pack.sketch) {
      const cmd = installPackSketch(doc, track.id, pack.sketch);
      if (cmd) {
        services.store.execute(cmd);
        installedScenes = pack.sketch.scenes.length;
      }
    }
    setKitStatus(installedScenes ? `Pack installed — ${installedScenes} scenes added` : "Pack installed");
  };

  return (
    <section className="rack" aria-label="Drum Rack">
      <div className="rack-header" role="group" aria-label="Note Repeat">
        <span className="rack-header-title">NOTE REPEAT</span>
        <label className="rack-header-field">
          <span>RATE</span>
          <select
            aria-label="Note repeat rate"
            value={repeatRate}
            onChange={(e) => {
              const rate = e.target.value as RepeatRate;
              setRepeatRate(rate);
              services.noteRepeat.setRate(rate);
            }}
          >
            {REPEAT_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </label>
        <label className="rack-header-field">
          <span>VELO</span>
          <select
            aria-label="Note repeat velocity falloff"
            value={falloff}
            disabled={repeatRate === "off"}
            onChange={(e) => {
              const mode = e.target.value as FalloffMode;
              setFalloff(mode);
              services.noteRepeat.setFalloff(mode);
            }}
          >
            {FALLOFF_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`rack-header-toggle${sixteenLevels ? " active" : ""}`}
          aria-pressed={sixteenLevels}
          title="16 LEVELS — every pad plays the selected sound at a fixed velocity by position"
          onClick={() => setSixteenLevels((v) => !v)}
        >
          16 LVL
        </button>
        <button
          type="button"
          className={`rack-header-toggle${kitMenu ? " active" : ""}`}
          title="User kits — save the current pad mapping, apply saved kits, share via kit codes"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setKitMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          KIT
        </button>
        <button
          type="button"
          className={`rack-header-toggle${keysMenu ? " active" : ""}`}
          title="Pad keys — rebind the QWERTY keys that play each pad (AZERTY/SK layouts)"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCaptureIndex(null);
            setKeysMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          KEYS
        </button>
        <span className="rack-header-hint">hold pad · right-click = pad rate · QWERTYUI·ASDFGHJK</span>
      </div>
      {track.pads.map((pad, index) => {
        const hit = playheadStep >= 0 && (pattern.rows[pad.id]?.[playheadStep] ?? 0) > 0;
        const selected = pad.id === selectedPadId;
        const holdKey = padKeyOf(pad.id);
        const pinned: RepeatRate | undefined = pinnedRates[pad.id];
        const effectiveRate = effectiveRateOf(pinned, repeatRate);
        return (
          <button
            key={pad.id}
            type="button"
            className={`pad${hit ? " hit" : ""}${selected ? " selected" : ""}`}
            style={{ "--pad-color": categoryColor(assetCategoryOf(pad)) } as React.CSSProperties}
            title={`${pad.name} — hold to play${effectiveRate !== "off" ? ` (repeats ${effectiveRate}, velocity ${falloff})` : ""} — key ${(padKeys[index] || "—").toUpperCase()} — right-click for rate/colour`}
            onContextMenu={(event) => {
              event.preventDefault();
              setRateMenu({ padId: pad.id, x: event.clientX, y: event.clientY });
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              // In 16 LEVELS the pads are velocity lanes — selection stays locked.
              if (!sixteenLevels) onSelectPad(pad.id);
              padDown(pad.id, holdKey);
            }}
            onPointerUp={() => padUp(holdKey)}
            onPointerLeave={() => padUp(holdKey)}
            onPointerCancel={() => padUp(holdKey)}
            onKeyDown={(event) => {
              // Keyboard-activated button (Enter/Space): single hit, no hold.
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (!sixteenLevels) onSelectPad(pad.id);
                triggerPad(sixteenLevels ? selectedPadId || pad.id : pad.id);
              }
            }}
          >
            <span className="pad-index">{index + 1}</span>
            <span className="pad-name">{pad.name}</span>
            {sixteenLevels && (
              <span className="pad-rate-badge">{Math.round(((index + 1) / track.pads.length) * 100)}%</span>
            )}
            {pinned && <span className="pad-rate-badge">{pinned}</span>}
            {pad.synth && <span className="pad-synth-badge">{pad.synth.type.slice(0, 3).toUpperCase()}</span>}
            <span className="pad-meter" aria-hidden="true">
              <span className="pad-meter-fill" style={{ height: `${Math.min(100, (peaks[pad.id] ?? 0) * 100)}%` }} />
            </span>
          </button>
        );
      })}
      {rateMenu && (
        <div
          className="context-menu"
          role="menu"
          aria-label="Pad repeat rate"
          style={{ left: rateMenu.x, top: rateMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-header">PAD REPEAT RATE</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setPinnedRates((prev) => {
                const next = { ...prev };
                delete next[rateMenu.padId];
                return next;
              });
              setRateMenu(null);
            }}
          >
            Inherit global ({repeatRate})
          </button>
          {PINNABLE_RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              role="menuitem"
              onClick={() => {
                setPinnedRates((prev) => ({ ...prev, [rateMenu.padId]: rate }));
                setRateMenu(null);
              }}
            >
              {rate}
              {pinnedRates[rateMenu.padId] === rate ? " ✓" : ""}
            </button>
          ))}
          <div className="context-menu-header">COLOR</div>
          <div className="pad-color-row">
            {PAD_COLOR_SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="menuitemradio"
                aria-checked={track.pads.find((p) => p.id === rateMenu.padId)?.color === swatch}
                className="pad-color-swatch"
                style={{ background: swatch }}
                title={swatch}
                onClick={() => {
                  try {
                    services.store.execute(setPadColor(services.store.doc, track.id, rateMenu.padId, swatch));
                  } catch {
                    setKitStatus("Colour change failed");
                  }
                  setRateMenu(null);
                }}
              />
            ))}
            <button
              type="button"
              role="menuitem"
              className="pad-color-auto"
              title="Back to the category colour"
              onClick={() => {
                try {
                  services.store.execute(setPadColor(services.store.doc, track.id, rateMenu.padId, null));
                } catch {
                  setKitStatus("Clear failed");
                }
                setRateMenu(null);
              }}
            >
              AUTO
            </button>
          </div>
        </div>
      )}
      {kitMenu && (
        <div
          className="context-menu"
          role="menu"
          aria-label="User kits"
          style={{ left: kitMenu.x, top: kitMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-header">USER KITS</div>
          <button type="button" role="menuitem" onClick={saveCurrentKit}>
            💾 Save current ({track.name})
          </button>
          {userKits.map((kit) => (
            <div key={kit.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                role="menuitem"
                style={{ flex: 1, textAlign: "left" }}
                title="Apply this kit to the current drum track"
                onClick={() => {
                  applyKit(kit);
                  setKitMenu(null);
                }}
              >
                {kit.name}
              </button>
              <button
                type="button"
                role="menuitem"
                title="Copy kit share code"
                aria-label={`Copy share code for ${kit.name}`}
                onClick={() => void copyKitCode(kit)}
              >
                ⇧
              </button>
              <button
                type="button"
                role="menuitem"
                title="Delete kit"
                aria-label={`Delete ${kit.name}`}
                onClick={() => deleteKit(kit)}
              >
                ×
              </button>
            </div>
          ))}
          {userKits.length > 0 && <div className="context-menu-header">SHARE</div>}
          <button type="button" role="menuitem" onClick={installFromCode}>
            Install from code…
          </button>
          <div className="context-menu-header">PACK</div>
          <button type="button" role="menuitem" onClick={() => void copyPackCode()}>
            Copy PACK (kit+keys+theme+grooves+scenes)
          </button>
          <button type="button" role="menuitem" onClick={installPackCode}>
            Install PACK…
          </button>
          {kitStatus && <div className="context-menu-header">{kitStatus}</div>}
        </div>
      )}
      {keysMenu && (
        <div
          className="context-menu"
          role="menu"
          aria-label="Pad keys"
          style={{ left: keysMenu.x, top: keysMenu.y, minWidth: 230 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-header">PAD KEYS</div>
          <div className="pad-keys-grid">
            {track.pads.slice(0, 16).map((pad, index) => (
              <button
                key={pad.id}
                type="button"
                role="menuitemradio"
                aria-checked={captureIndex === index}
                className={`pad-key-slot${captureIndex === index ? " capturing" : ""}`}
                title={`${pad.name} — click, then press a key`}
                onClick={(event) => {
                  event.stopPropagation();
                  setCaptureIndex(captureIndex === index ? null : index);
                  setKeyStatus(null);
                }}
              >
                <span className="pad-key-index">{index + 1}</span>
                {(padKeys[index] || "—").toUpperCase()}
              </button>
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              resetPadKeys();
              setKeyStatus("Keys reset");
            }}
          >
            Reset to QWERTY defaults
          </button>
          <div className="context-menu-header">SHARE</div>
          <div className="context-menu-header">
            {captureIndex !== null
              ? `PRESS A KEY FOR PAD ${captureIndex + 1} (Esc cancels)`
              : (keyStatus ?? "Pad keys shadow plain-letter shortcuts")}
          </div>
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        title="Copy a PFBIND1 code with your pad keymap"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(encodeBindsCode(getPadKeys()));
            setKeyStatus("BINDS code copied — paste it into any KYX");
          } catch {
            setKeyStatus("Clipboard blocked by the browser");
          }
        }}
      >
        Copy BINDS code
      </button>
      <button
        type="button"
        role="menuitem"
        title="Install a keymap from a PFBIND1 code"
        onClick={() => {
          const code = window.prompt("Paste a KYX BINDS code (PFBIND1:…)");
          if (!code) return;
          const keys = decodeBindsCode(code);
          if (!keys) {
            setKeyStatus("Invalid BINDS code");
            return;
          }
          importPadKeys(keys);
          setKeyStatus("Keymap installed");
        }}
      >
        Install from code…
      </button>
    </section>
  );
}
