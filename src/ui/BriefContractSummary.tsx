import { useState } from "react";
import {
  BRIEF_SECTION_LABELS,
  unprotectRole,
  type BriefContract,
  type BriefSection,
  type BriefStatement,
} from "../intent/brief-contract";
import type { IntentInput } from "../intent/types";

/**
 * "TOTO SOM POCHOPIL" (Fáza 1 — AI-first producer): the confirmable brief
 * contract above the GENERATE action. Statements render grouped by section;
 * unknown/inferred ones offer their suggested patch as a one-click fix, and
 * the exact hard facts (BPM/key/length) are editable in place so the user
 * corrects individual points without rewriting the prompt.
 */
const SECTION_ORDER: readonly BriefSection[] = ["hard", "preference", "prohibition", "preserve", "unknown"];

interface BriefContractSummaryProps {
  contract: BriefContract;
  /** Effective merged input (parsed + fixes) — un-protect patches from it. */
  input: IntentInput;
  /** User fixes already merged into `input` (used to mark applied fixes). */
  fixes: IntentInput;
  onPatch: (patch: IntentInput) => void;
}

export function BriefContractSummary({ contract, input, fixes, onPatch }: BriefContractSummaryProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitBpm = (raw: string) => {
    const value = Math.round(Number(raw.replace(",", ".")));
    setEditing(null);
    if (!Number.isFinite(value) || value < 40 || value > 240) return;
    onPatch({ bpmRange: [value, value] });
  };

  const commitBars = (raw: string) => {
    const bars = Math.round(Number(raw));
    setEditing(null);
    if (!Number.isFinite(bars) || bars < 1 || bars > 16) return;
    onPatch({ length: bars * 16 });
  };

  const renderStatement = (statement: BriefStatement) => {
    // Suggested fix (unknown/inferred with a patch) — one click confirms it.
    if (statement.patch) {
      return (
        <button
          key={statement.id}
          type="button"
          className="brief-chip brief-fix"
          title="Použiť tento návrh"
          onClick={() => onPatch(statement.patch ?? {})}
        >
          {"+ "}
          {statement.label}
        </button>
      );
    }

    if (statement.section === "preserve" && statement.role) {
      return (
        <span key={statement.id} className="brief-chip brief-keep">
          {statement.label}
          <button
            type="button"
            className="brief-unkeep"
            title="Už nechrániť — bude sa generovať"
            aria-label={`Prestať chrániť ${statement.role}`}
            onClick={() => onPatch(unprotectRole(input, statement.role as NonNullable<BriefStatement["role"]>))}
          >
            ×
          </button>
        </span>
      );
    }

    if (editing === statement.id) {
      const isBpm = statement.id === "bpm";
      const isLength = statement.id === "length";
      return (
        <span key={statement.id} className="brief-chip brief-editing">
          <input
            className="brief-input"
            type="text"
            inputMode="numeric"
            autoFocus
            defaultValue={draft}
            placeholder={isBpm ? "BPM" : isLength ? "takty" : ""}
            aria-label={isBpm ? "Nové BPM" : "Počet taktov"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (isBpm ? commitBpm : commitBars)(draft);
              if (e.key === "Escape") setEditing(null);
            }}
          />
        </span>
      );
    }

    const editable = statement.id === "bpm" || statement.id === "length";
    const fixed = editable && fixes[statement.id === "bpm" ? "bpmRange" : "length"] !== undefined;
    return (
      <button
        key={statement.id}
        type="button"
        className={"brief-chip" + (statement.section === "hard" ? " brief-hard" : "") + (fixed ? " brief-fixed" : "")}
        title={editable ? "Klikni a oprav" : ""}
        onClick={
          editable
            ? () => {
                setDraft(
                  statement.id === "bpm" ? String(input.bpmRange?.[0] ?? "") : String((input.length ?? 128) / 16),
                );
                setEditing(statement.id);
              }
            : undefined
        }
      >
        {statement.label}
        {fixed ? " ✎" : ""}
      </button>
    );
  };

  const groups = SECTION_ORDER.map((section) => ({
    section,
    items: contract.statements.filter((statement) => statement.section === section),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="brief-contract" aria-label="Toto som pochopil">
      <span className="brief-title">TOTO SOM POCHOPIL</span>
      {groups.map((group) => (
        <div key={group.section} className="brief-row">
          <span className={"brief-section brief-section-" + group.section}>{BRIEF_SECTION_LABELS[group.section]}</span>
          <span className="brief-chips">{group.items.map(renderStatement)}</span>
        </div>
      ))}
    </div>
  );
}
