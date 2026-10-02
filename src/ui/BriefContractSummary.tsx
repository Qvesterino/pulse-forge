import { useState } from "react";
import {
  BRIEF_SECTION_LABELS,
  unprotectRole,
  type BriefConfidence,
  type BriefContract,
  type BriefOrigin,
  type BriefSection,
  type BriefStatement,
} from "../intent/brief-contract";
import type { IntentInput, IntentRole } from "../intent/types";

/**
 * "TOTO SOM POCHOPIL" (Fáza 1 — AI-first producer): the confirmable brief
 * contract above the GENERATE action. Statements render grouped by section;
 * unknown/inferred ones offer their suggested patch as a one-click fix, and
 * the exact hard facts (BPM/key/length) are editable in place so the user
 * corrects individual points without rewriting the prompt.
 */
const SECTION_ORDER: readonly BriefSection[] = ["hard", "preference", "prohibition", "preserve", "unknown"];
const INTENT_ROLES: readonly IntentRole[] = ["drums", "bass", "chords", "lead"];
const ROLE_TOGGLE_LABELS: Readonly<Record<IntentRole, string>> = {
  drums: "bicie",
  bass: "basu",
  chords: "akordy",
  lead: "lead",
};
const ORIGIN_LABELS: Readonly<Record<BriefOrigin, string>> = {
  prompt: "zadanie",
  session: "session",
  project: "projekt",
  default: "predvolené",
  user: "tvoja oprava",
};
const CONFIDENCE_LABELS: Readonly<Record<BriefConfidence, string>> = {
  parsed: "rozpoznané",
  inferred: "odhad",
  unknown: "nezadané",
  confirmed: "potvrdené",
};

function BriefProvenance({ statement }: { statement: BriefStatement }) {
  const origin = ORIGIN_LABELS[statement.origin];
  const confidence = CONFIDENCE_LABELS[statement.confidence];
  return (
    <span
      className="brief-provenance"
      data-origin={statement.origin}
      data-confidence={statement.confidence}
      aria-label={`Pôvod: ${origin}; istota: ${confidence}`}
      title={`Pôvod: ${origin}; istota: ${confidence}`}
    >
      {origin} · {confidence}
    </span>
  );
}

interface BriefContractSummaryProps {
  contract: BriefContract;
  /** Effective merged input (parsed + fixes) — un-protect patches from it. */
  input: IntentInput;
  /** User fixes already merged into `input` (used to mark applied fixes). */
  fixes: IntentInput;
  /** Must match the generation defaults so unprotecting a role is faithful. */
  defaultRoles?: readonly IntentRole[];
  onPatch: (patch: IntentInput) => void;
}

export function BriefContractSummary({
  contract,
  input,
  fixes,
  defaultRoles = ["drums", "bass"],
  onPatch,
}: BriefContractSummaryProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const prohibitedRoles = contract.statements
    .filter((statement) => statement.section === "prohibition" && statement.role)
    .map((statement) => statement.role as IntentRole);
  const preservedRoles = input.preserve ?? [];
  const selectedRoles = new Set(
    (input.roles ?? defaultRoles).filter((role) => !prohibitedRoles.includes(role) && !preservedRoles.includes(role)),
  );

  const toggleGenerationRole = (role: IntentRole) => {
    const next = new Set(selectedRoles);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    if (next.size === 0) return;
    onPatch({ roles: INTENT_ROLES.filter((candidate) => next.has(candidate)) });
  };

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
    if (statement.id === "roles") {
      const corrected = fixes.roles !== undefined;
      return (
        <div key={statement.id} className="brief-role-controls" role="group" aria-label="Roly na generovanie">
          <span className="brief-role-prompt">Generovať</span>
          {INTENT_ROLES.map((role) => {
            const selected = selectedRoles.has(role);
            const prohibited = prohibitedRoles.includes(role);
            const preserved = preservedRoles.includes(role);
            const lastSelectedRole = selected && selectedRoles.size === 1;
            const disabled = prohibited || preserved || lastSelectedRole;
            const title = prohibited
              ? "Zakázané v zadaní"
              : preserved
                ? "Táto rola je chránená — odomkni ju v časti ZACHOVAŤ"
                : lastSelectedRole
                  ? "Aspoň jedna rola musí zostať vybraná"
                  : `Prepnúť generovanie: ${ROLE_TOGGLE_LABELS[role]}`;
            return (
              <button
                key={role}
                type="button"
                className={
                  "brief-chip brief-hard brief-role-toggle" +
                  (selected ? " brief-role-selected" : "") +
                  (corrected ? " brief-fixed" : "")
                }
                aria-label={`Generovať ${ROLE_TOGGLE_LABELS[role]}`}
                aria-pressed={selected}
                disabled={disabled}
                title={title}
                onClick={() => toggleGenerationRole(role)}
              >
                {ROLE_TOGGLE_LABELS[role]}
              </button>
            );
          })}
          <BriefProvenance statement={statement} />
        </div>
      );
    }

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
          <span className="brief-statement-label">+ {statement.label}</span>
          <BriefProvenance statement={statement} />
        </button>
      );
    }

    if (statement.section === "preserve" && statement.role) {
      return (
        <span key={statement.id} className="brief-chip brief-keep">
          <span className="brief-statement-label">{statement.label}</span>
          <BriefProvenance statement={statement} />
          <button
            type="button"
            className="brief-unkeep"
            title="Už nechrániť — bude sa generovať"
            aria-label={`Prestať chrániť ${statement.role}`}
            onClick={() =>
              onPatch(
                unprotectRole(
                  input,
                  statement.role as NonNullable<BriefStatement["role"]>,
                  defaultRoles,
                  prohibitedRoles,
                ),
              )
            }
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
          <BriefProvenance statement={statement} />
        </span>
      );
    }

    const editable = statement.id === "bpm" || statement.id === "length";
    const fixed = editable && fixes[statement.id === "bpm" ? "bpmRange" : "length"] !== undefined;
    const corrected = statement.origin === "user";
    return (
      <button
        key={statement.id}
        type="button"
        className={
          "brief-chip" +
          (statement.section === "hard" ? " brief-hard" : "") +
          (fixed || corrected ? " brief-fixed" : "")
        }
        title={corrected ? "Opravené tebou — klikni a zmeň" : editable ? "Klikni a oprav" : ""}
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
        <span className="brief-statement-label">{statement.label}</span>
        <BriefProvenance statement={statement} />
        {corrected ? " ✓" : fixed ? " ✎" : ""}
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
      {contract.conflicts.length > 0 && (
        <div className="brief-conflicts" aria-label="Rozpory v zadaní" role="alert">
          <span className="brief-conflict-title">ROZPOR</span>
          {contract.conflicts.map((conflict) => (
            <span key={conflict.id} className="brief-conflict-message">
              {conflict.label}
            </span>
          ))}
          <span className="brief-conflict-hint">Uprav konfliktné pokyny. Generovanie čaká na jednoznačné zadanie.</span>
        </div>
      )}
      {groups.map((group) => (
        <div key={group.section} className="brief-row">
          <span className={"brief-section brief-section-" + group.section}>{BRIEF_SECTION_LABELS[group.section]}</span>
          <span className="brief-chips">{group.items.map(renderStatement)}</span>
        </div>
      ))}
    </div>
  );
}
