/**
 * INTENT PLAN — the dry-runnable IR between "what the producer said" and
 * "what the store will do".
 *
 * Why this exists:
 *   - the UI could preview a PARAM change but a fader/effect/exact ask was
 *     opaque until it had already executed;
 *   - MCP could execute but not answer "what would this do?" without mutating;
 *   - verification and explanation each re-derived the same numbers.
 *
 * `planIntent` is PURE: it builds the same canonical command the executor
 * would build, runs it against the document value (commands are snapshots),
 * and describes the diff. It never touches the store. That is what makes the
 * plan trustworthy: it is the execution path, not a second calculation.
 *
 * The plan is deliberately honest about its limits:
 *   - routes without a pure command (generation, loudness measure/trim,
 *     mix-profile audition) return `executable: false` with a warning;
 *   - a no-op command is a plan, not an error;
 *   - clamps, added effects and unmatched targets are stated in the step.
 */
import type { ProjectDocument } from "../../project-model/types";
import type { RoutedIntent } from "../route";
import { buildIntentCommand } from "../command-for-route";
import { paramPlan } from "../param-intent";
import { EFFECT_META } from "../../effects/definitions";
import type { ParamDef } from "../../effects/types";
import { trackIdsForTarget } from "../conversation";
import { EFFECT_KNOB } from "../mix";
import { targetTrackIds } from "./target-resolution";

export type PlanDomain = "linear" | "log" | "db" | "normalized" | "boolean" | "none";

export interface NumberPlanStep {
  kind: "number";
  target: string;
  parameter: string;
  before: number;
  proposed: number;
  next: number;
  beforeLabel: string;
  proposedLabel: string;
  nextLabel: string;
  domain: PlanDomain;
  direction?: "up" | "down";
  clamped: boolean;
  note?: string;
}

export interface StatePlanStep {
  kind: "state";
  target: string;
  parameter: string;
  beforeLabel: string;
  afterLabel: string;
  note?: string;
}

export interface CommandPlanStep {
  kind: "command";
  target: string;
  note: string;
}

export type PlanStep = NumberPlanStep | StatePlanStep | CommandPlanStep;

export interface IntentPlan {
  routeKind: RoutedIntent["kind"];
  summary: string;
  steps: PlanStep[];
  warnings: string[];
  /** True only when the dry run produced a different document. */
  mutates: boolean;
  /** True when the route maps to a canonical command at all. */
  executable: boolean;
  commandLabel?: string;
  /** The dry-run result. NEVER passed to the store by this module. */
  after: ProjectDocument;
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function paramFormat(def: ParamDef): (value: number) => string {
  return def.format ?? ((value: number) => (def.unit ? `${fmt(value, def.max <= 1 ? 2 : 1)} ${def.unit}` : fmt(value)));
}

function domainOf(def: ParamDef): PlanDomain {
  if (def.unit === "dB") return "db";
  if (def.kind === "enum" || def.kind === "toggle") return "boolean";
  return def.taper === "log" ? "log" : "linear";
}

function numberStep(
  target: string,
  parameter: string,
  before: number,
  proposed: number,
  next: number,
  label: (value: number) => string,
  domain: PlanDomain,
  note?: string,
): NumberPlanStep {
  return {
    kind: "number",
    target,
    parameter,
    before,
    proposed,
    next,
    beforeLabel: label(before),
    proposedLabel: label(proposed),
    nextLabel: label(next),
    domain,
    direction: next > before ? "up" : next < before ? "down" : undefined,
    clamped: Math.abs(next - proposed) > 1e-9,
    ...(note ? { note } : {}),
  };
}

function faderSteps(
  before: ProjectDocument,
  after: ProjectDocument,
  intent: Extract<RoutedIntent, { kind: "fader" }>["intent"],
): PlanStep[] {
  const steps: PlanStep[] = [];
  const gain = (target: string, from: number | undefined, to: number | undefined): void => {
    if (from == null || to == null || from === to) return;
    steps.push(
      numberStep(
        target,
        "fader.gain",
        from,
        to,
        to,
        (value) => fmt(value),
        "normalized",
        from > 0 ? `×${fmt(to / from, 3)}` : undefined,
      ),
    );
  };

  for (const target of intent.targets) {
    if (target === "master") {
      gain("master", before.master?.masterGain, after.master?.masterGain);
      continue;
    }
    for (const trackId of trackIdsForTarget(before, target)) {
      const oldTrack = before.tracks.find((track) => track.id === trackId);
      const newTrack = after.tracks.find((track) => track.id === trackId);
      gain(oldTrack?.name ?? target, oldTrack?.gain, newTrack?.gain);
    }
  }
  for (const trackId of intent.trackIds ?? []) {
    const oldTrack = before.tracks.find((track) => track.id === trackId);
    const newTrack = after.tracks.find((track) => track.id === trackId);
    gain(oldTrack?.name ?? trackId, oldTrack?.gain, newTrack?.gain);
  }
  for (const returnId of intent.returnIds ?? []) {
    const oldReturn = before.returns.find((item) => item.id === returnId);
    const newReturn = after.returns.find((item) => item.id === returnId);
    gain(`return ${oldReturn?.name ?? returnId}`, oldReturn?.gain, newReturn?.gain);
  }
  if ((intent.pads?.length ?? 0) > 0) {
    const oldDrum = before.tracks.find((track) => track.kind === "drum");
    const newDrum = after.tracks.find((track) => track.kind === "drum");
    if (oldDrum?.kind === "drum" && newDrum?.kind === "drum") {
      for (const [index, pad] of oldDrum.pads.entries()) {
        const next = newDrum.pads[index];
        if (next && pad.gain !== next.gain) {
          steps.push(
            numberStep(
              `${oldDrum.name} · ${pad.name}`,
              "fader.gain",
              pad.gain,
              next.gain,
              next.gain,
              (value) => fmt(value),
              "normalized",
              pad.gain > 0 ? `×${fmt(next.gain / pad.gain, 3)}` : undefined,
            ),
          );
        }
      }
    }
  }
  return steps;
}

function paramSteps(
  doc: ProjectDocument,
  intent: Extract<RoutedIntent, { kind: "paramIntent" }>["intent"],
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of paramPlan(intent, doc)) {
    const def = EFFECT_META[line.effectType]?.params.find((param) => param.id === line.paramId);
    if (!def) continue;
    if (line.label.endsWith("no matching track")) {
      steps.push({ kind: "command", target: line.target, note: "no matching track" });
      continue;
    }
    const noteParts: string[] = [];
    if (line.deltaLabel !== "set") {
      noteParts.push(line.family === "db" ? line.deltaLabel : `${line.deltaLabel} (${line.family})`);
    }
    if (line.adding) noteParts.push("add effect");
    steps.push(
      numberStep(
        line.trackName,
        `${line.effectType}.${line.paramId}`,
        line.current,
        line.proposed,
        line.next,
        paramFormat(def),
        domainOf(def),
        noteParts.join(" · ") || undefined,
      ),
    );
  }
  return steps;
}

function effectSteps(
  before: ProjectDocument,
  after: ProjectDocument,
  intent: Extract<RoutedIntent, { kind: "effectIntent" }>["intent"],
): PlanStep[] {
  const steps: PlanStep[] = [];
  const knob = EFFECT_KNOB[intent.effectType];
  for (const trackId of targetTrackIds(before, intent.targets, intent.trackIds, intent.trackOrdinal)) {
      const oldTrack = before.tracks.find((track) => track.id === trackId);
      const newTrack = after.tracks.find((track) => track.id === trackId);
      if (!oldTrack || !newTrack) continue;
      const oldFx = oldTrack.effects.find((effect) => effect.type === intent.effectType);
      const newFx = newTrack.effects.find((effect) => effect.type === intent.effectType);
      if (oldFx && !newFx) {
        steps.push({
          kind: "state",
          target: oldTrack.name,
          parameter: `${intent.effectType}`,
          beforeLabel: "on",
          afterLabel: "removed",
        });
        continue;
      }
      if (!oldFx && newFx) {
        // The add is a change even when the knob lands on its default value
        // ("set reverb mix to 30%": the effect appears, the mix is unchanged).
        steps.push({
          kind: "state",
          target: oldTrack.name,
          parameter: intent.effectType,
          beforeLabel: "off",
          afterLabel: "on",
          note: "add effect",
        });
      }
      const paramIds = new Set([
        ...(oldFx ? Object.keys(oldFx.params) : []),
        ...(newFx ? Object.keys(newFx.params) : []),
      ]);
      if (knob) paramIds.add(knob);
      for (const paramId of paramIds) {
        const def = EFFECT_META[intent.effectType]?.params.find((param) => param.id === paramId);
        if (!def) continue;
        const from = oldFx?.params[paramId] ?? def.default;
        const to = newFx?.params[paramId];
        if (to == null || from === to) continue;
        const label = paramFormat(def);
        const note = !oldFx ? "add effect" : paramId === knob ? intent.direction : undefined;
        if (def.kind === "enum" || def.kind === "toggle") {
          steps.push({
            kind: "state",
            target: oldTrack.name,
            parameter: `${intent.effectType}.${paramId}`,
            beforeLabel: label(from),
            afterLabel: label(to),
            ...(note ? { note } : {}),
          });
        } else {
          steps.push(
            numberStep(oldTrack.name, `${intent.effectType}.${paramId}`, from, to, to, label, domainOf(def), note),
          );
        }
      }
    }
  return steps;
}

function exactSteps(
  before: ProjectDocument,
  after: ProjectDocument,
  plan: Extract<RoutedIntent, { kind: "exact" }>["plan"],
): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const op of plan.ops) {
    switch (op.kind) {
      case "tempo":
        steps.push(
          numberStep("project", "tempo", before.bpm, after.bpm, after.bpm, (value) => `${fmt(value, 1)} BPM`, "linear"),
        );
        break;
      case "mute":
      case "solo":
        steps.push({
          kind: "state",
          target: op.target,
          parameter: op.kind,
          beforeLabel: op.value ? "off" : "on",
          afterLabel: op.value ? "on" : "off",
        });
        break;
      case "pan":
        steps.push({
          kind: "state",
          target: op.target,
          parameter: "pan",
          beforeLabel: "current",
          afterLabel: fmt(op.value, 0),
        });
        break;
      case "gainDb":
        steps.push({
          kind: "state",
          target: op.target,
          parameter: "gain",
          beforeLabel: "current",
          afterLabel: `${op.deltaDb > 0 ? "+" : ""}${op.deltaDb} dB${op.assumed ? " (default)" : ""}`,
        });
        break;
      case "gainDbAbsolute":
        steps.push({
          kind: "state",
          target: op.target,
          parameter: "gain",
          beforeLabel: "current",
          afterLabel: `${op.absDb} dB`,
        });
        break;
      case "transpose":
        steps.push({
          kind: "state",
          target: op.target,
          parameter: "transpose",
          beforeLabel: "current",
          afterLabel: `${op.semitones > 0 ? "+" : ""}${op.semitones} st`,
        });
        break;
      case "patternLength":
        steps.push({
          kind: "state",
          target: "pattern",
          parameter: "length",
          beforeLabel: "current",
          afterLabel: `${op.steps} steps`,
        });
        break;
      case "patternLengthDelta":
        steps.push({
          kind: "state",
          target: "pattern",
          parameter: "length",
          beforeLabel: "current",
          afterLabel: `${op.bars > 0 ? "+" : ""}${op.bars} bars`,
        });
        break;
      case "patternLengthBars":
        steps.push({
          kind: "state",
          target: "pattern",
          parameter: "length",
          beforeLabel: "current",
          afterLabel: `${op.bars} bars`,
        });
        break;
      case "swing":
        steps.push({
          kind: "state",
          target: "groove",
          parameter: "swing",
          beforeLabel: "current",
          afterLabel: `${op.percent}%`,
        });
        break;
      case "timeSignature":
        steps.push({
          kind: "state",
          target: "project",
          parameter: "time signature",
          beforeLabel: "current",
          afterLabel: `${op.numerator}/${op.denominator}`,
        });
        break;
      case "addTrack":
        steps.push({ kind: "command", target: "tracks", note: `add ${op.trackKind} (${op.instrument})` });
        break;
      case "removeTrack":
        steps.push({ kind: "command", target: op.target, note: "remove track" });
        break;
      case "renameTrack":
        steps.push({ kind: "command", target: op.target, note: `rename to "${op.name}"` });
        break;
      case "duplicateTrack":
        steps.push({ kind: "command", target: op.target, note: "duplicate track" });
        break;
      case "key":
        steps.push({ kind: "state", target: "project", parameter: "key", beforeLabel: "current", afterLabel: op.key });
        break;
    }
  }
  return steps;
}

function compoundSteps(doc: ProjectDocument, route: Extract<RoutedIntent, { kind: "compound" }>): PlanStep[] {
  let cursor = doc;
  const steps: PlanStep[] = [];
  for (const part of route.parts) {
    let partRoute: RoutedIntent | null = null;
    switch (part.kind) {
      case "fader":
        partRoute = { kind: "fader", intent: part.intent };
        break;
      case "tempo":
        partRoute = { kind: "tempo", intent: part.intent };
        break;
      case "effect":
        partRoute = { kind: "effectIntent", intent: part.intent };
        break;
      case "send":
        partRoute = { kind: "sendIntent", intent: part.intent };
        break;
      case "bypass":
        partRoute = { kind: "bypassIntent", intent: part.intent };
        break;
      case "exact":
        partRoute = { kind: "exact", plan: part.plan };
        break;
      case "preset":
        partRoute = { kind: "preset", intent: part.intent };
        break;
    }
    if (!partRoute) continue;
    const partPlan = planIntent(cursor, partRoute);
    steps.push(...partPlan.steps);
    cursor = partPlan.after;
  }
  return steps;
}

function stepsFor(doc: ProjectDocument, after: ProjectDocument, route: RoutedIntent): PlanStep[] {
  switch (route.kind) {
    case "fader":
      return faderSteps(doc, after, route.intent);
    case "paramIntent":
      return paramSteps(doc, route.intent);
    case "effectIntent":
      return effectSteps(doc, after, route.intent);
    case "exact":
      return exactSteps(doc, after, route.plan);
    case "tempo":
      return [
        numberStep("project", "tempo", doc.bpm, after.bpm, after.bpm, (value) => `${fmt(value, 1)} BPM`, "linear"),
      ];
    case "compound":
      return compoundSteps(doc, route);
    default:
      return [];
  }
}

function unavailable(doc: ProjectDocument, route: RoutedIntent, warning: string): IntentPlan {
  return {
    routeKind: route.kind,
    summary: warning,
    steps: [],
    warnings: [warning],
    mutates: false,
    executable: false,
    after: doc,
  };
}

/**
 * Build the plan for a routed intent against the current document. Pure: the
 * command is executed on the document VALUE (snapshot semantics), never on the
 * store.
 */
export function planIntent(doc: ProjectDocument, route: RoutedIntent): IntentPlan {
  let command: ReturnType<typeof buildIntentCommand>;
  try {
    command = buildIntentCommand(doc, route);
  } catch (error) {
    return unavailable(doc, route, error instanceof Error ? error.message : String(error));
  }
  if (!command) {
    const message =
      route.kind === "pattern" || route.kind === "revise"
        ? "generation runs in the app and needs auditioning — no dry-run command"
        : route.kind === "clarify"
          ? "the router asks a question — nothing to execute"
          : `"${route.kind}" has no dry-runnable command (it needs app services)`;
    return unavailable(doc, route, message);
  }
  let after: ProjectDocument;
  try {
    after = command.execute(doc);
  } catch (error) {
    return unavailable(doc, route, error instanceof Error ? error.message : String(error));
  }
  const steps = stepsFor(doc, after, route);
  const warnings: string[] = [];
  for (const step of steps) {
    if (step.kind === "command") warnings.push(`${step.target}: ${step.note}`);
    else if (step.kind === "number" && step.clamped) warnings.push(`${step.target}: ${step.parameter} will clamp`);
  }
  if (after === doc) warnings.push("nothing would change");
  return {
    routeKind: route.kind,
    summary: command.label,
    steps,
    warnings,
    mutates: after !== doc,
    executable: true,
    commandLabel: command.label,
    after,
  };
}

function formatStep(step: PlanStep): string {
  if (step.kind === "command") return `${step.target}: ${step.note}`;
  if (step.kind === "state") {
    return `${step.target}: ${step.parameter} ${step.beforeLabel} → ${step.afterLabel}${step.note ? ` · ${step.note}` : ""}`;
  }
  const values =
    step.clamped && step.proposed !== step.next
      ? `${step.beforeLabel} → ${step.proposedLabel} (clamped to ${step.nextLabel})`
      : `${step.beforeLabel} → ${step.nextLabel}`;
  return `${step.target}: ${step.parameter} ${values}${step.note ? ` · ${step.note}` : ""}`;
}

/** The single-line, human-readable plan used by the IntentPanel status area. */
export function formatPlan(plan: IntentPlan): string {
  if (plan.steps.length === 0) return plan.warnings[0] ?? plan.summary;
  return plan.steps.map(formatStep).join("  ·  ");
}

