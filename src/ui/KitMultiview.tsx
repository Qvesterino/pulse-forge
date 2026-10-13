import type { EffectType, Track } from "../project-model/types";
import { EFFECT_DEFS } from "../effects/registry";
import { ESSENTIAL_KIT_SLOTS, type EssentialKitSlot } from "../effects/essentialKit";
import { effectEditorSpec } from "./effectEditorRegistry";
import { EffectParameterGrid } from "./EffectParameterGrid";

type KitMultiviewProps = {
  track: Track;
  /** Commit one parameter through the shared effect command path. */
  onChange: (fxId: string, paramId: string, value: number) => void;
};

/**
 * The five ESSENTIAL KIT devices side by side, each showing its curated
 * `primaryParamIds` page — the same first page the single-device editor shows
 * as MAIN, so a knob means the same thing in both places.
 *
 * This is a VIEW of the document, not a second source of truth: values come
 * from `track.effects[i].params` and every drag commits through the command
 * the rest of the rack uses. No local parameter state exists here, which is
 * what keeps undo/redo and the offline renderer in agreement with the dock.
 */
export function KitMultiview({ track, onChange }: KitMultiviewProps) {
  const effects = "effects" in track ? track.effects : [];
  if (effects.length === 0) return null;

  // First instance of each kit device, in slot order — a track holding two
  // reverbs edits the one that LOAD KIT inserted, not the last one dragged in.
  const byType = new Map<EffectType, (typeof effects)[number]>();
  for (const fx of effects) if (!byType.has(fx.type)) byType.set(fx.type, fx);

  const live = ESSENTIAL_KIT_SLOTS.flatMap((slot) => {
    const fx = byType.get(slot.type);
    return fx ? [{ slot, fx }] : [];
  });
  if (live.length === 0) return null;

  return (
    <section className="kit-multiview" aria-label="Essential kit devices">
      {live.map(({ slot, fx }) => (
        <KitDeviceColumn key={fx.id} slot={slot} fx={fx} onChange={onChange} />
      ))}
    </section>
  );
}

function KitDeviceColumn({
  slot,
  fx,
  onChange,
}: {
  slot: EssentialKitSlot;
  fx: { id: string; type: EffectType; params: Record<string, number> };
  onChange: (fxId: string, paramId: string, value: number) => void;
}) {
  const def = EFFECT_DEFS[fx.type];
  const spec = effectEditorSpec(fx.type, fx.params);
  // Resolve through the real ParamDef list so a stale id in the registry
  // renders four knobs instead of throwing mid-panel.
  const params = (spec.primaryParamIds ?? [])
    .map((id) => def.params.find((param) => param.id === id))
    .filter((param): param is (typeof def.params)[number] => !!param);

  return (
    <div className="kit-multiview-device" data-type={fx.type}>
      <div className="kit-multiview-head">
        <span className="kit-multiview-name">{def.name}</span>
        <span className="kit-multiview-slot">{slot.label}</span>
      </div>
      {params.length > 0 ? (
        <EffectParameterGrid
          family={spec.family}
          params={params}
          values={fx.params}
          paged={false}
          onChange={(paramId, value) => onChange(fx.id, paramId, value)}
        />
      ) : (
        <span className="kit-multiview-empty">no primary controls</span>
      )}
    </div>
  );
}
