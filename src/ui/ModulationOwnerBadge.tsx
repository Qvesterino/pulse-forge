import { useServices, useModulationOwnership } from "./context";
import { modulationOwner, modulationSourceRank, type ModulationSource } from "../project-model/modulation-precedence";
import type { AutomationTarget } from "../project-model/types";

/**
 * "KTO RIADI" badge — the disclosure half of the modulation precedence
 * (ADR 0067, audit F-11).
 *
 * Four sources write one effect parameter (automation, modulator, macro,
 * MIDI CC) and the precedence says who wins. Before the ADR the loser was
 * dropped SILENTLY: the user moved the macro and nothing happened, with no
 * hint that an automation lane was holding the parameter. The badge names the
 * owner instead of leaving the user to guess.
 *
 * The owner is read from the document through the read model
 * (`modulation-precedence.ts`) — the same rule the engine's write gate
 * applies, so the badge can never disagree with the engine.
 */

const OWNER_LABEL: Record<ModulationSource, string> = {
  automation: "AUTO",
  modulator: "LFO",
  macro: "MAKRO",
  midiCC: "CC",
};

const OWNER_TITLE: Record<ModulationSource, string> = {
  automation: "Tento parameter riadi automatická dráha — pri prehrávaní má prednosť pred makrom.",
  modulator: "Tento parameter riadi modulátor — pri prehrávaní má prednosť pred makrom.",
  macro: "Tento parameter riadi makro.",
  midiCC: "Tento parameter riadi MIDI CC.",
};

/**
 * The badge for one or more modulation targets.
 *
 * Renders nothing when nothing outranks the macro — a macro that owns its
 * parameter needs no explanation, and a track gain/pan (which composes through
 * its own bus) has no owner at all.
 */
export function ModulationOwnerBadge({ targets }: { targets: AutomationTarget[] }) {
  const services = useServices();
  const ownership = useModulationOwnership();
  const doc = services.store.getDoc();
  let owner: ModulationSource | null = null;
  for (const target of targets) {
    const candidate = modulationOwner(doc, target, ownership);
    if (!candidate) continue;
    // Keep the HIGHEST owner: automation outranks the modulator outranks the
    // macro. The order of the targets must not change what the badge says.
    if (!owner || modulationSourceRank(candidate) < modulationSourceRank(owner)) owner = candidate;
  }
  if (!owner || owner === "macro") return null;
  return (
    <span className="mod-owner-badge" title={OWNER_TITLE[owner]} data-testid="mod-owner-badge">
      {OWNER_LABEL[owner]}
    </span>
  );
}
