import type { Track } from "../project-model/types";
import type { SourceMacro, SourceProfile, SourceProfileId } from "../effects/sourceProfiles";
import { Slider } from "./controls";

type SourceMacroDockProps = {
  track: Track;
  profile: SourceProfile;
  profileIds: readonly SourceProfileId[];
  loadedEffectIds: readonly string[];
  onSelectProfile: (id: SourceProfileId) => void;
  onLoadProfile: () => void;
  onCommitMacro: (macro: SourceMacro, value: number) => void;
};

function ratioFor(value: number, from: number, to: number): number {
  const span = to - from;
  if (Math.abs(span) < 1e-9) return 0.5;
  return Math.min(1, Math.max(0, (value - from) / span));
}

export function SourceMacroDock({
  track,
  profile,
  profileIds,
  loadedEffectIds,
  onSelectProfile,
  onLoadProfile,
  onCommitMacro,
}: SourceMacroDockProps) {
  const loaded = loadedEffectIds.length > 0;
  const effects = "effects" in track ? track.effects : [];
  const hasAllTargets = profile.macros.every((macro) =>
    macro.targets.every((target) => {
      const fx = effects.find((candidate) => candidate.id === loadedEffectIds[target.slot]);
      return !!fx && Number.isFinite(fx.params[target.paramId]);
    }),
  );

  const valueFor = (macro: SourceMacro): number => {
    if (!loaded || !hasAllTargets) return macro.defaultValue;
    const first = macro.targets[0];
    if (!first) return macro.defaultValue;
    const fx = effects.find((candidate) => candidate.id === loadedEffectIds[first.slot]);
    return fx ? ratioFor(fx.params[first.paramId], first.from, first.to) : macro.defaultValue;
  };

  return (
    <section className="source-macro-dock" aria-label="Beat source shortcuts">
      <div className="source-macro-head">
        <div>
          <span className="source-macro-kicker">SOURCE</span>
          <span className="source-macro-title">{profile.label}</span>
          <span className="source-macro-description">{profile.description}</span>
        </div>
        <button
          type="button"
          className="btn btn-small source-macro-load"
          onClick={onLoadProfile}
          title={`Insert the ${profile.label} starter chain on ${track.name}`}
        >
          {loaded && hasAllTargets ? "RELOAD" : "LOAD"} {profile.label}
        </button>
      </div>
      <div className="source-profile-tabs" role="tablist" aria-label="Choose beat source">
        {profileIds.map((id) => {
          const selected = id === profile.id;
          const label = id === "vocalChop" ? "VOCAL" : id.toUpperCase();
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`source-profile-tab${selected ? " is-active" : ""}`}
              onClick={() => onSelectProfile(id)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="source-macro-grid">
        {profile.macros.map((macro) => {
          const value = valueFor(macro);
          return (
            <Slider
              key={macro.label}
              compact
              label={macro.label}
              min={0}
              max={1}
              defaultValue={macro.defaultValue}
              value={value}
              format={(next) => `${Math.round(next * 100)}%`}
              onCommit={(next) => onCommitMacro(macro, next)}
              disabled={!loaded || !hasAllTargets}
            />
          );
        })}
      </div>
      {!loaded || !hasAllTargets ? (
        <span className="source-macro-hint">LOAD {profile.label} TO ARM THESE MACROS</span>
      ) : (
        <span className="source-macro-hint">SOURCE MACROS · ONE UNDO STEP</span>
      )}
    </section>
  );
}
