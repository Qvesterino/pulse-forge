/**
 * QUANTITY — the explicit-number half of the deterministic grammar.
 *
 * Degree words ("a little") and quantities ("−9 dB", "half", "twice", "one
 * step") were parsed by separate route regexes. That is why a sentence could
 * be exact in one route and fuzzy in another. This module is the shared
 * interpretation of an EXPLICIT quantity; the caller still owns direction and
 * target.
 *
 * The shape distinguishes the three questions the resolver must answer:
 *
 *   absolute  — a destination ("to −9 dB")
 *   delta     — a movement ("by 2 dB")
 *   factor    — a scaling ("half", "twice")
 *   steps     — a count of calibrated steps ("one step further")
 *
 * A bare number without a unit is deliberately NOT a quantity here; guessing
 * dB vs % vs Hz is how a precise ask becomes an unsafe one.
 */
export type Quantity =
  | { kind: "db"; value: number; absolute: boolean }
  | { kind: "percent"; value: number; absolute: boolean }
  | { kind: "factor"; value: number }
  | { kind: "steps"; count: number };

const NUMBER = String.raw`-?\d+(?:[.,]\d+)?`;

function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

export function parseQuantity(text: string): Quantity | null {
  const lower = text.toLowerCase();

  // Destination before movement: "set it to -9 dB" is absolute even though it
  // also contains a number.
  const absoluteDb = new RegExp(String.raw`\b(?:to|na)\s*(${NUMBER})\s*db\b`, "i").exec(lower);
  if (absoluteDb) return { kind: "db", value: toNumber(absoluteDb[1]!), absolute: true };

  const deltaDb = new RegExp(String.raw`\b(?:by|o)\s*(${NUMBER})\s*db\b`, "i").exec(lower);
  if (deltaDb) return { kind: "db", value: toNumber(deltaDb[1]!), absolute: false };

  // A bare "−9 dB" next to a movement verb is a delta; an isolated sign is
  // still an explicit quantity, not a degree word.
  const bareDb = new RegExp(String.raw`(${NUMBER})\s*db\b`, "i").exec(lower);
  if (bareDb) return { kind: "db", value: toNumber(bareDb[1]!), absolute: false };

  const absolutePercent = new RegExp(String.raw`\b(?:to|na)\s*(${NUMBER})\s*%`, "i").exec(lower);
  if (absolutePercent) return { kind: "percent", value: toNumber(absolutePercent[1]!), absolute: true };

  const percent = new RegExp(String.raw`(${NUMBER})\s*%`, "i").exec(lower);
  if (percent) return { kind: "percent", value: toNumber(percent[1]!), absolute: false };

  // Scaling words. "half as much" and "half that adjustment" both scale the
  // prior/requested amount; "twice" doubles it.
  if (/\bhalf\b/.test(lower)) return { kind: "factor", value: 0.5 };
  if (/\b(?:twice|double|double up|as much again)\b/.test(lower)) return { kind: "factor", value: 2 };

  const steps = /\b(one|two|three|four|five|six|seven|eight|\d+)\s*(?:more\s+)?(?:step|steps|notch|notches)\b/i.exec(
    lower,
  );
  if (steps) {
    const raw = steps[1]!.toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (count != null && count > 0) return { kind: "steps", count };
  }

  return null;
}

export function formatQuantity(quantity: Quantity): string {
  switch (quantity.kind) {
    case "db":
      return `${quantity.absolute ? "to " : ""}${quantity.value > 0 ? "+" : ""}${quantity.value} dB`;
    case "percent":
      return `${quantity.absolute ? "to " : ""}${quantity.value > 0 ? "+" : ""}${quantity.value}%`;
    case "factor":
      return `×${quantity.value}`;
    case "steps":
      return `${quantity.count} step${quantity.count === 1 ? "" : "s"}`;
  }
}
