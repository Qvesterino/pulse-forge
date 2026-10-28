import { useState } from "react";
import { setMcpAllowDestructive, setMcpAllowMutations } from "../mcp/flags";
import { useMcpAllowDestructive, useMcpAllowMutations } from "./context";

/**
 * ADR 0065 — standing consent for an EXTERNAL agent (web relay, desktop stdio,
 * QMR) to CHANGE the project. Separate from MAZANIE on purpose: a read-only
 * analysis agent is legitimate. Default OFF, read live on every call.
 *
 * One component for both MCP surfaces, so the two toggles cannot drift.
 */
export function McpConsentToggle() {
  const allowed = useMcpAllowMutations();
  return (
    <button
      type="button"
      className={`btn btn-small${allowed ? " intent-mcp-consent-on" : ""}`}
      onClick={() => setMcpAllowMutations(!allowed)}
      title={
        allowed
          ? "Externý agent MÔŽE meniť projekt (pridávať, upravovať, mazať podľa MAZANIE). Klikni pre zákaz."
          : "Zmeny cez externého agenta sú ZAMKNUTÉ (odporúčané) — externý klient môže len čítať. Klikni pre povolenie."
      }
      aria-pressed={allowed}
    >
      {allowed ? "🔓 ZMENY" : "🔒 ZMENY"}
    </button>
  );
}

/**
 * Delete authority is the sharpest MCP flag (tracks / sections / FX removal).
 * Turning it ON is a two-step action — the first click only opens an inline
 * confirmation that names the scope; turning it OFF is immediate. The global
 * TopBar badge reads the same store, so "it is still on" is never invisible.
 */
export function McpDestructiveToggle() {
  const allowed = useMcpAllowDestructive();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="intent-mcp-confirm" role="group" aria-label="Confirm MCP delete authority">
        <span className="intent-mcp-confirm-text">Povoliť externým agentom MAZAŤ tracky, sekcie a FX?</span>
        <button
          type="button"
          className="btn btn-small btn-danger"
          onClick={() => {
            setMcpAllowDestructive(true);
            setConfirming(false);
          }}
        >
          POVOLIŤ MAZANIE
        </button>
        <button type="button" className="btn btn-small" autoFocus onClick={() => setConfirming(false)}>
          ZRUŠIŤ
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`btn btn-small${allowed ? " intent-mcp-destructive-on" : ""}`}
      onClick={() => {
        if (allowed) setMcpAllowDestructive(false);
        else setConfirming(true);
      }}
      title={
        allowed
          ? "Mazanie (tracky/sekcie/FX) cez MCP je POVOLENÉ — externý klient môže mazať. Klikni pre zákaz."
          : "Mazanie cez MCP je zamknuté — externý klient môže pridávať/upravovať len ak je zapnuté aj ZMENY."
      }
      aria-pressed={allowed}
    >
      {allowed ? "🔓 MAZANIE" : "🔒 MAZANIE"}
    </button>
  );
}
