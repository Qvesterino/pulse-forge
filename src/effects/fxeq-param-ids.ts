/**
 * PRISM (fxeq) parameter-id translation — BOTH directions, ONE owner.
 *
 * The rack surface (the registry params stored in the document as
 * `EffectInstance.params`) names the global wet/dry `mix`; the vendored core
 * schema names the same control `globalMix`, in a different SCALE (document
 * 0..1, core 0..100 percent).
 *
 * The map used to live alone in `fxeqNode.ts` and only ever travelled
 * host → DSP. That one-way map is why the in-plugin Undo/Redo wrote the
 * document in the CORE's id and the CORE's scale: `normalizePluginParams`
 * treats `mix` as the source of truth and re-derives `globalMix` from it, so
 * a write-back under the core id was silently discarded — the DSP moved, the
 * document did not, and a save + reload changed the sound (audit F-28).
 *
 * Both directions now live here, so a value crossing the boundary either way
 * has exactly one owner, and a caller cannot write an id the normaliser will
 * discard.
 */

/** One translated id pair: the document's canonical id, the DSP's id, and the
 *  value conversion in both directions. */
interface FxEqIdAlias {
  /** Canonical DOCUMENT id — what the project stores and what the UI shows. */
  rackId: string;
  /** DSP (core) id. */
  coreId: string;
  /** document value → DSP value */
  toCore: (v: number) => number;
  /** DSP value → document value */
  toRack: (v: number) => number;
}

const FXEQ_ID_ALIASES: readonly FxEqIdAlias[] = [
  // The rack exposes the global wet/dry as `mix` (0..1); the vendored core
  // names the same control `globalMix` (0..100 percent).
  { rackId: "mix", coreId: "globalMix", toCore: (v) => v * 100, toRack: (v) => v / 100 },
];

/** The alias pair an id belongs to, from EITHER side. */
function aliasFor(id: string): FxEqIdAlias | undefined {
  return FXEQ_ID_ALIASES.find((alias) => alias.rackId === id || alias.coreId === id);
}

/** Rack/document id → DSP (core) id. Identity when the ids agree. */
export function toCoreId(id: string): string {
  return FXEQ_ID_ALIASES.find((alias) => alias.rackId === id)?.coreId ?? id;
}

/** DSP (core) id → rack/document id. Identity when the ids agree. */
export function toRackId(id: string): string {
  return FXEQ_ID_ALIASES.find((alias) => alias.coreId === id)?.rackId ?? id;
}

/**
 * Document value → DSP value, for ANY id of a translated pair.
 *
 * The document stores BOTH sides in the DOCUMENT scale (`mix` 0..1 and the
 * derived `globalMix` 0..1 — the normaliser divides the core's percent), so
 * both ids must bridge to the core's percent on the way to the DSP.
 */
export function documentValueToCore(id: string, value: number): number {
  const alias = aliasFor(id);
  return alias ? alias.toCore(value) : value;
}

/**
 * DSP (core) value → document value.
 *
 * Only a CORE id carries the core's scale. A rack id is already in the
 * document's scale and is returned untouched.
 */
export function coreValueToDocument(id: string, value: number): number {
  const alias = FXEQ_ID_ALIASES.find((a) => a.coreId === id);
  return alias ? alias.toRack(value) : value;
}

/**
 * TRUE when the id belongs to a translated pair — i.e. the document must
 * store it under its RACK id, because the normaliser treats the rack id as
 * the source of truth and re-derives the core id from it.
 */
export function isTranslatedId(id: string): boolean {
  return aliasFor(id) !== undefined;
}
