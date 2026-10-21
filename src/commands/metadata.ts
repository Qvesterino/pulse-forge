/**
 * Project-level metadata: the key and the tag list the exporters and the scorepack read.
 */
import type { Command } from "./types";
import type { MusicalKey, ProjectDocument } from "../project-model/types";
import { meterChangeClause } from "../project-model/meter-disclosure";
import { snapshot } from "./core";

/* ---------------- metadata & scorepack ---------------- */ export function setProjectKey(
  doc: ProjectDocument,
  key: MusicalKey | null,
): Command {
  const next: ProjectDocument = key
    ? { ...doc, key }
    : (() => {
        const { key: _drop, ...rest } = doc;
        return rest as ProjectDocument;
      })();
  // Delta snapshot — see setStepsLocks for why whole-doc pins are forbidden.
  return snapshot("setProjectKey", key ? `Set project key to ${key}` : "Clear project key", doc, next);
}
/**
 * GAP-12 (control-surface audit 2026-10-13): the ONLY writer of
 * `doc.timeSignature` used to be the migration — the value was readable
 * everywhere (ticksPerBar drives transport.setBarTicks on every doc change)
 * but no surface could set it. Validation mirrors the migration's
 * isValidTimeSignature and adds the musical bounds the MCP/NL callers
 * promise: numerator 1..16, denominator a power-of-two beat unit.
 */
export function setTimeSignature(doc: ProjectDocument, numerator: number, denominator: number): Command {
  const valid =
    Number.isInteger(numerator) &&
    Number.isInteger(denominator) &&
    numerator >= 1 &&
    numerator <= 16 &&
    [2, 4, 8, 16].includes(denominator);
  if (!valid) {
    throw new Error(`invalid time signature ${numerator}/${denominator} — numerator 1..16, denominator 2|4|8|16`);
  }
  const next: ProjectDocument = { ...doc, timeSignature: { numerator, denominator } };
  // The meter is NOT changed silently (ADR 0056): the command's detail is the
  // consequence note the toast shows under the label, and it says what the new
  // metre MEASURES and what happens to a pattern authored in the old one. The
  // clause is the shared one — the same words the intent read-back, the MCP
  // response and the transfer dialog use.
  const clause = meterChangeClause(doc, next.timeSignature);
  return {
    ...snapshot("setTimeSignature", `Time signature ${numerator}/${denominator}`, doc, next),
    detail: clause ?? undefined,
  };
}
export function setProjectTags(doc: ProjectDocument, tags: string[]): Command {
  const prev = doc.tags;
  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    type: "setProjectTags",
    label: "Edit project tags",
    execute: (d) => ({ ...d, tags: cleaned }),
    undo: (d) =>
      prev
        ? { ...d, tags: prev }
        : (() => {
            const { tags: _drop, ...rest } = d;
            return rest as ProjectDocument;
          })(),
  };
}
