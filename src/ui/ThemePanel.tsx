import { THEME_PRESETS, accentOf, resetTheme, setTheme, useTheme } from "./theme";
import { decodeThemeCode, encodeThemeCode } from "../export/themeCode";
import { useState } from "react";

/**
 * Theme panel — preset palettes, custom accent hue, UI scale, density and
 * motion preferences. Opens from the THEME button in the TopBar.
 */
export function ThemePanel() {
  const theme = useTheme();
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  return (
    <div className="theme-panel" role="group" aria-label="Theme settings">
      <div className="theme-panel-title">THEME</div>

      <div className="theme-presets">
        {THEME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`theme-preset${theme.preset === preset.id ? " active" : ""}`}
            aria-pressed={theme.preset === preset.id}
            title={`${preset.name} palette`}
            onClick={() => setTheme({ preset: preset.id, hue: null })}
          >
            <span className="theme-preset-dot" style={{ background: preset.accent }} aria-hidden="true" />
            {preset.name}
          </button>
        ))}
      </div>

      <label className="theme-row">
        <span className="theme-row-label">ACCENT HUE</span>
        <input
          type="range"
          min={0}
          max={359}
          value={theme.hue ?? hueOfAccent(accentOf(theme))}
          aria-label="Custom accent hue"
          onChange={(event) => setTheme({ hue: Number(event.target.value) })}
        />
        <button
          type="button"
          className="theme-mini-btn"
          title="Reset the accent to the preset colour"
          disabled={theme.hue === null}
          onClick={() => setTheme({ hue: null })}
        >
          ↺
        </button>
      </label>

      <label className="theme-row">
        <span className="theme-row-label">UI SIZE</span>
        <input
          type="range"
          min={85}
          max={125}
          step={5}
          value={Math.round(theme.scale * 100)}
          aria-label="Interface zoom"
          onChange={(event) => setTheme({ scale: Number(event.target.value) / 100 })}
        />
        <span className="theme-row-value">{Math.round(theme.scale * 100)}%</span>
      </label>

      <div className="theme-row">
        <button
          type="button"
          className={`theme-mini-btn theme-toggle${theme.compact ? " on" : ""}`}
          aria-pressed={theme.compact}
          title="Compact density — tighter paddings and gaps"
          onClick={() => setTheme({ compact: !theme.compact })}
        >
          COMPACT
        </button>
        <button
          type="button"
          className={`theme-mini-btn theme-toggle${theme.reduceMotion ? " on" : ""}`}
          aria-pressed={theme.reduceMotion}
          title="Disable transitions and animations"
          onClick={() => setTheme({ reduceMotion: !theme.reduceMotion })}
        >
          CALM MOTION
        </button>
        <button type="button" className="theme-mini-btn" title="Reset all theme preferences" onClick={resetTheme}>
          RESET
        </button>
      </div>

      <div className="theme-share">
        <div className="theme-row">
          <button
            type="button"
            className="theme-mini-btn"
            title="Copy a PFTHM1 code with your current look"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(encodeThemeCode(theme));
                setShareStatus("Theme code copied — paste it into any KYX");
              } catch {
                setShareStatus("Clipboard blocked by the browser");
              }
            }}
          >
            COPY THEME CODE
          </button>
          <button
            type="button"
            className="theme-mini-btn"
            title="Install a look from a PFTHM1 code"
            onClick={() => {
              const code = window.prompt("Paste a theme code (PFTHM1:…)");
              if (!code) return;
              const decoded = decodeThemeCode(code);
              if (!decoded) {
                setShareStatus("Invalid theme code");
                return;
              }
              setTheme(decoded);
              setShareStatus("Theme installed");
            }}
          >
            INSTALL FROM CODE…
          </button>
        </div>
        {shareStatus && <div className="theme-share-status">{shareStatus}</div>}
      </div>
    </div>
  );
}

/** Hue of the current effective accent (for the slider position). */
function hueOfAccent(accent: string): number {
  const hsl = /^hsl\((\d+)/.exec(accent);
  if (hsl) return Number(hsl[1]);
  const hex = /^#([0-9a-f]{6})$/i.exec(accent);
  if (hex) {
    const int = parseInt(hex[1], 16);
    const r = ((int >> 16) & 255) / 255;
    const g = ((int >> 8) & 255) / 255;
    const b = (int & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let hue = 0;
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    return (hue * 60 + 360) % 360;
  }
  return 30;
}
