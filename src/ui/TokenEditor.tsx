import { useCallback, useMemo, useState } from "react";
import { getLayoutSnapshot, setLayout, useLayout } from "./layout";
import {
  buildTokenCatalog,
  COLOR_TOKENS,
  setTokenOverride,
  TOKEN_GROUPS,
  toHexInput,
  type ColorTokenDef,
} from "./tokenCatalog";

/**
 * TOKEN EDITOR — per-variable colour overrides (ADR 0036, confirmed scope).
 *
 * The palette presets only own eleven variables, and the glass/elevation layer
 * is not preset-aware at all. This is the surface that closes that gap: every
 * authorized colour token gets a swatch, a hex field, and a reset that returns
 * it to the preset.
 *
 * THE RESET IS NOT OPTIONAL. An override the user cannot see or undo is a trap:
 * they change one colour, later cannot tell why the UI looks "off", and have no
 * way back except a full reset that throws away everything else they tuned.
 * Every row therefore has a visible, per-token reset — it appears only when
 * that token actually carries an override.
 */

interface TokenRowProps {
  token: ColorTokenDef;
  value: string | null;
  overridden: boolean;
  onChange: (value: string | null) => void;
}

function TokenRow({ token, value, overridden, onChange }: TokenRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const hex = value ? toHexInput(value) : null;

  // The draft lets the user type a partial hex without the row fighting them
  // mid-edit; an empty/invalid draft simply renders the live value again.
  const shown = draft ?? value ?? "";

  const commit = useCallback(
    (next: string) => {
      setDraft(null);
      const trimmed = next.trim();
      // Reject an unparseable value rather than writing garbage into a custom
      // property: sanitizeColorOverrides would drop it silently, and a field
      // that silently swallows input is worse than one that keeps the old value.
      if (trimmed && toHexInput(trimmed) === null) return;
      onChange(trimmed || null);
    },
    [onChange],
  );

  return (
    <div className={"token-row" + (overridden ? " overridden" : "")}>
      <label className="token-row-label" title={token.hint}>
        {token.label}
        <code className="token-row-id">{token.id}</code>
      </label>
      <span className="token-row-swatch" style={{ background: value ?? "transparent" }} aria-hidden="true" />
      {hex ? (
        <input
          type="color"
          className="token-row-color"
          aria-label={`${token.label} colour picker`}
          value={hex}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      <input
        type="text"
        className="token-row-hex"
        aria-label={`${token.label} hex value`}
        value={shown}
        placeholder={value ? "" : "preset"}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit((event.target as HTMLInputElement).value);
          } else if (event.key === "Escape") {
            setDraft(null);
          }
        }}
      />
      {overridden && (
        <button
          type="button"
          className="token-row-reset"
          title={`Reset ${token.label} to the palette value`}
          aria-label={`Reset ${token.label}`}
          onClick={() => onChange(null)}
        >
          ↺
        </button>
      )}
    </div>
  );
}

export function TokenEditor() {
  const layout = useLayout();
  const [expanded, setExpanded] = useState(false);

  // Read the live document once per layout change: a preset switch changes the
  // effective value of every unoverridden token, so the swatches must follow.
  const root = typeof document === "undefined" ? null : document.documentElement;
  const catalog = useMemo(
    () => buildTokenCatalog(root, layout.colorOverrides),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout.colorOverrides, layout.preset, layout.hue],
  );

  const overrideCount = Object.keys(layout.colorOverrides).length;
  const handleChange = useCallback((id: string, value: string | null) => {
    // Read the live map rather than closing over a possibly stale snapshot:
    // two edits in one tick must not drop each other.
    setLayout({ colorOverrides: setTokenOverride(getLayoutSnapshot().colorOverrides, id, value) });
  }, []);

  if (!expanded) {
    return (
      <div className="token-editor" role="group" aria-label="Colour token editor">
        <button
          type="button"
          className={"token-editor-toggle" + (overrideCount ? " active" : "")}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          COLOURS
          {overrideCount > 0 && <span className="token-editor-count">{overrideCount}</span>}
          <span className="token-editor-hint">per-token editor</span>
        </button>
      </div>
    );
  }

  return (
    <div className="token-editor" role="group" aria-label="Colour token editor">
      <div className="token-editor-head">
        <span className="token-editor-title">COLOUR TOKENS</span>
        <button
          type="button"
          className="token-editor-collapse"
          aria-label="Collapse colour token editor"
          onClick={() => setExpanded(false)}
        >
          ▴
        </button>
      </div>

      {overrideCount > 0 && (
        <button
          type="button"
          className="token-editor-reset-all"
          title="Remove every custom colour and return to the palette"
          onClick={() => setLayout({ colorOverrides: {} })}
        >
          RESET ALL {overrideCount}
        </button>
      )}

      {TOKEN_GROUPS.map((group) => {
        const rows = catalog.filter((entry) => entry.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="token-group">
            <div className="token-group-title">{group}</div>
            {rows.map((row) => (
              <TokenRow
                key={row.id}
                token={row}
                value={row.current}
                overridden={row.overridden}
                onChange={(value) => handleChange(row.id, value)}
              />
            ))}
          </div>
        );
      })}

      <p className="token-editor-foot">
        {COLOR_TOKENS.length} tokens · a token you set wins over the palette until you reset it. Colours are shared with{" "}
        <code>PFLYT1:</code> codes.
      </p>
    </div>
  );
}
