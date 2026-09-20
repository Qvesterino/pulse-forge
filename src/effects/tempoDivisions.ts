/** Shared quarter-note beat lengths for musical sync controls across FX. */
export const TEMPO_NOTE_DIVISIONS = [
  { label: "1/1", beats: 4 },
  { label: "1/2", beats: 2 },
  { label: "1/4", beats: 1 },
  { label: "1/8", beats: 0.5 },
  { label: "1/16", beats: 0.25 },
  { label: "1/32", beats: 0.125 },
  { label: "1/2D", beats: 3 },
  { label: "1/2T", beats: 4 / 3 },
  { label: "1/4D", beats: 1.5 },
  { label: "1/4T", beats: 2 / 3 },
  { label: "1/8D", beats: 0.75 },
  { label: "1/8T", beats: 1 / 3 },
  { label: "1/16D", beats: 0.375 },
  { label: "1/16T", beats: 1 / 6 },
  { label: "1/32D", beats: 0.1875 },
  { label: "1/32T", beats: 1 / 12 },
] as const;

export type TempoDivisionLabel = (typeof TEMPO_NOTE_DIVISIONS)[number]["label"];
export const TEMPO_DIVISION_BEATS: Readonly<Record<TempoDivisionLabel, number>> = Object.fromEntries(
  TEMPO_NOTE_DIVISIONS.map(({ label, beats }) => [label, beats]),
) as Record<TempoDivisionLabel, number>;

/**
 * Build an effect's serialized index map while letting its dropdown use one
 * shared musical order. Keep each effect's existing `idOrder` prefix intact;
 * projects persist the numeric ids in `params`.
 */
export function tempoDivisionOptions(
  idOrder: readonly string[],
  optionOrder: readonly string[] = TEMPO_NOTE_DIVISIONS.map(({ label }) => label),
): { value: number; label: string }[] {
  return optionOrder
    .map((label) => ({ value: idOrder.indexOf(label), label }))
    .filter((option) => option.value >= 0);
}

export function tempoDivisionBeatsById(idOrder: readonly string[]): number[] {
  return idOrder.map((label) => (label === "OFF" ? 0 : (TEMPO_DIVISION_BEATS as Record<string, number>)[label] ?? 0));
}
