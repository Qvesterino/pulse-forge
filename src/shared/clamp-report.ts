/**
 * clamp-report — the DISCLOSURE of a value the domain had to change.
 *
 * Audit F-12 (STATE_DIVERGENCE_HUNTER_REPORT.md): a command whose label says
 * "Set PRISM Cutoff" silently wrote a different value than the one that was
 * asked for. The domain clamped it (the value had to be clamped — an
 * out-of-range cutoff reaching the DSP is worse than a snapped one), but the
 * clamp was INVISIBLE: the toast showed only the label, so the human could
 * not tell an honoured request from a rewritten one.
 *
 * This module is the vocabulary of that disclosure. It is deliberately a LEAF:
 * no domain imports, no React, no store. The producers (the clamp helpers in
 * `src/effects` / `src/instruments` / `src/project-model`, and the store's
 * normaliser footprint reader) supply the numbers and the labels; this module
 * only names them and renders them.
 *
 * Two kinds of disclosure, because they are not the same failure:
 *
 * - `ValueClamp` — a NUMBER the caller asked for that the domain had to
 *   change before it could be applied ("999 → 20, allowed 20..20000").
 * - `RepairClamp` — a document field the domain removed or filled in beyond
 *   what the command's label says ("the legacy limiterStereoLink field was
 *   dropped"). A repair is not a clamp: no value was requested, so there is
 *   nothing to compare — but it is equally invisible, and the doctrine
 *   ("a value the user set is either honoured or the change is disclosed")
 *   covers it.
 *
 * The coverage boundary is deliberate and is part of the contract:
 *
 * - PARAMETER clamps are reported. A knob, a fader, an automation value, a
 *   master setting — the caller expressed an intent, and the domain changed
 *   it.
 * - STRUCTURAL clamps stay silent. Ticks, bars, array indices, MIDI pitch
 *   (0..127), note velocity — these are coordinates, not musical values. They
 *   are clamped on EVERY drag, and a toast per tick would be noise that
 *   teaches the reader to ignore the toast.
 *
 * The disclosure travels ON THE COMMAND (`Command.clamps`), never through a
 * global. A module-level "last clamp" side channel would attribute one
 * command's clamp to the next command built inside the same tick, and the
 * report would name a value the user never asked about.
 */

/** A numeric value the caller asked for that the domain had to change. */
export interface ValueClamp {
  readonly kind: "value";
  /**
   * Stable machine id — "effect:prism.cutoff", "master:limiterLookaheadMs".
   * Machine-readable so an agent can match a clamp against the parameter it
   * wrote, without parsing the human label.
   */
  readonly target: string;
  /** Human label — "PRISM Cutoff". Shown in the toast. */
  readonly label: string;
  /** What the caller asked for. */
  readonly requested: number;
  /** What was actually applied. */
  readonly applied: number;
  /**
   * The authoritative lower/upper bound of the target. Absent when the
   * reporting layer does not know the range — the normaliser's footprint is
   * read from the document, which carries the values but not the rules.
   */
  readonly min?: number;
  readonly max?: number;
  /**
   * WHY the value changed, when the rule is not a plain range clamp — a snap
   * to a musical grid ("power of two", "crossover order 1/2/4"), or a
   * non-finite input that fell back to the default. When this is absent the
   * range is the explanation.
   */
  readonly note?: string;
}

/** A document field the domain removed or filled in beyond the command's label. */
export interface RepairClamp {
  readonly kind: "repair";
  /** Stable machine id — "master.limiterStereoLink". */
  readonly target: string;
  /** Human label — "master.limiterStereoLink". */
  readonly label: string;
  /** What happened, in one clause. */
  readonly note: string;
}

export type ClampEvent = ValueClamp | RepairClamp;

/**
 * Where a producer sends its events. A producer takes an OPTIONAL sink: with
 * no sink installed (the load/import path, a read path, the engine's own
 * normalisation) nothing is recorded and nothing changes.
 */
export type ClampSink = (event: ClampEvent) => void;

/**
 * Build a value-clamp event — or nothing, when the value did not change.
 *
 * The "nothing" case is the common one and MUST stay silent: a helper is
 * called on every write, and a legal value is not an event.
 */
export function valueClamp(
  target: string,
  label: string,
  requested: number,
  applied: number,
  min: number,
  max: number,
  note?: string,
): ValueClamp | undefined {
  if (applied === requested) return undefined;
  return { kind: "value", target, label, requested, applied, min, max, ...(note !== undefined ? { note } : {}) };
}

/**
 * Build a value-clamp event for a producer that knows the two values but NOT
 * the range they had to land in — the normaliser's footprint, read from the
 * document. The disclosure still says what moved; it just cannot say what the
 * legal range was.
 */
export function valueClampUnranged(
  target: string,
  label: string,
  requested: number,
  applied: number,
  note?: string,
): ValueClamp | undefined {
  if (applied === requested) return undefined;
  return { kind: "value", target, label, requested, applied, ...(note !== undefined ? { note } : {}) };
}

/** Build a repair event. */
export function repairClamp(target: string, label: string, note: string): RepairClamp {
  return { kind: "repair", target, label, note };
}

/**
 * A collector for one command's events.
 *
 * The sink is a plain function, so a producer can wrap it to add context it
 * knows and the helper does not — an automation lane knows its track, a bulk
 * command knows it is a bulk command:
 *
 *   const { events, sink } = collectClamps();
 *   clampEffectParam(type, paramId, value, (event) =>
 *     sink({ ...event, label: `${trackName} · ${event.label}` }));
 */
export function collectClamps(): { events: ClampEvent[]; sink: ClampSink } {
  const events: ClampEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

/** Format a number for a human: integers stay bare, decimals keep 4 places. */
export function formatClampNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 0.0001) return value.toExponential(2);
  return String(Number(value.toFixed(4)));
}

/** One value clamp as a phrase: "999 → 20 (allowed 20..20000)". */
export function describeValueClamp(event: ValueClamp): string {
  const moved = `${formatClampNumber(event.requested)} → ${formatClampNumber(event.applied)}`;
  if (event.note !== undefined) return `${moved} (${event.note})`;
  if (event.min !== undefined && event.max !== undefined)
    return `${moved} (allowed ${formatClampNumber(event.min)}..${formatClampNumber(event.max)})`;
  return moved;
}

/**
 * Render a command's clamps as ONE line for the toast.
 *
 * The parameter is ALWAYS named: a bulk command's own label is generic ("Set
 * parameters"), and a line that said only "clamped to 20" would not say WHICH
 * parameter moved. Repetitions of one parameter collapse into "×N" — a curve
 * whose five points all overshot is one disclosure, not five.
 */
export function describeClamps(events: readonly ClampEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const values = events.filter((event): event is ValueClamp => event.kind === "value");
  const repairs = events.filter((event): event is RepairClamp => event.kind === "repair");
  const parts: string[] = [];
  if (values.length > 0) {
    const groups = new Map<string, ValueClamp[]>();
    for (const value of values) {
      const group = groups.get(value.target);
      if (group) group.push(value);
      else groups.set(value.target, [value]);
    }
    const rendered = [...groups.values()].map((group) => {
      const first = group[0]!;
      if (group.length === 1) return `${first.label} ${describeValueClamp(first)}`;
      const range =
        first.min !== undefined && first.max !== undefined
          ? ` (allowed ${formatClampNumber(first.min)}..${formatClampNumber(first.max)})`
          : "";
      return `${first.label} ×${group.length}${range}`;
    });
    if (groups.size === 1) parts.push(`clamped ${rendered[0]}`);
    else parts.push(`clamped ${values.length} values: ${rendered.join(", ")}`);
  }
  if (repairs.length > 0) parts.push(repairs.map((repair) => `repaired ${repair.label} (${repair.note})`).join("; "));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
