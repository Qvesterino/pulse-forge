import { useMemo, useState } from "react";
import {
  useActivePatternId,
  useDoc,
  useMacros,
  useScenes,
  useSelection,
  useSelectionStore,
  useServices,
  useTracks,
} from "./context";
import {
  applyKorenScenePair,
  applyTwistScenePair,
  korenSceneIntensityBound,
  setSceneCcOverride,
  setSceneCcRemap,
  setSceneIntensity,
  setSceneMacro,
  setSceneModulatorPattern,
  setScenePack,
  twistMorphIntensityBound,
} from "../commands/commands";
import { EFFECT_DEFS } from "../effects/registry";
import { readTwistCurvesState } from "../effects/skrutka-curves";
import { TWIST_SCENE_PACK, findTwistScenePair } from "../effects/skrutka-scene-pack";
import { readKorenSceneState } from "../effects/koren-scene";
import { KOREN_SCENE_PACK, findKorenScenePair } from "../effects/koren-scene-pack";
import { lfoKind, resolveLfoTarget, stepsOf } from "../project-model/modulators";
import { Slider } from "./controls";
import { NumericDraftInput } from "./NumericDraftInput";
import { formatMacroValue } from "./MacroPerformanceBar";

const COLLAPSE_KEY = "pf-scene-strip-collapsed";

interface SceneFxRow {
  key: string;
  trackId: string;
  trackName: string;
  fxId: string;
  kind: "twist" | "grow";
  effectName: string;
  /** Pack pair the stored slots match, else null (CUSTOM / nothing applied). */
  pairId: string | null;
  /** The effect already rides the scene intensity. */
  bound: boolean;
}

interface ModulatorRow {
  id: string;
  kind: "step" | "random";
  label: string;
  title: string;
}

/**
 * SCENE STRIP — the shared scene-intensity surface for the scene packs,
 * mounted on the mixer toolbar and in the arrangement scenes sidebar.
 *
 * One place plays both effects at once: the scene row edits the ACTIVE
 * scene's static intensity (the same `setSceneIntensity` command the model
 * defines; the arrangement's INTENSITY lane owns the curve, the chip reports
 * which one the engine will follow), and one row per TWIST/GROW device shows
 * its active A/B pair with a quick picker that applies a pack pair —
 * arming the intensity binding through the same one-undo commands the device
 * panels use. The SECOND picker on a row is the PER-SCENE pair
 * (`Scene.packs`): while this scene (or clip) plays, the engine overrides
 * the effect's applied pair with it at the clip boundary — intro/build/drop
 * scenes switch pairs automatically, live and in exports, without touching
 * the document baseline. The MACROS block pins macro values to the scene
 * (`Scene.macros`): while the scene is active the pinned value substitutes
 * the live macro in every macro-sourced mapping (effect params, gain/pan) —
 * the × clears a pin back to the live value. The track name selects the
 * strip's track so a row is one click from the device in the mixer.
 */
export function SceneStrip({ sceneId }: { sceneId?: string }) {
  const services = useServices();
  const tracks = useTracks();
  const scenes = useScenes();
  const activePatternId = useActivePatternId();
  const macros = useMacros();
  const selection = useSelection();
  const selectionStore = useSelectionStore();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const doc = useDoc();

  const scene = useMemo(() => {
    if (sceneId) {
      const selected = scenes.find((candidate) => candidate.id === sceneId);
      if (selected) return selected;
    }
    return scenes.find((candidate) => candidate.patternId === activePatternId) ?? scenes[0] ?? null;
  }, [sceneId, scenes, activePatternId]);

  const ccMappings = useMemo(() => {
    const out: Array<{ id: string; ccNumber: number; channel?: number; macroName: string }> = [];
    for (const macro of macros) {
      for (const mapping of macro.mappings) {
        if (mapping.source !== "midiCC" || typeof mapping.ccNumber !== "number") continue;
        out.push({ id: mapping.id, ccNumber: mapping.ccNumber, channel: mapping.channel, macroName: macro.name });
      }
    }
    return out;
  }, [macros]);

  const modulatorRows = useMemo(() => {
    const out: ModulatorRow[] = [];
    const lfos = doc.lfos ?? [];
    lfos.forEach((lfo, index) => {
      const kind = lfoKind(lfo);
      if (kind !== "step" && kind !== "random") return;
      const target = resolveLfoTarget(lfo);
      out.push({
        id: lfo.id,
        kind,
        label: `${kind === "step" ? "STEP" : "S&H"} ${index + 1}`,
        title: `→ ${target.kind}${target.paramId ? ` ${target.paramId}` : ""} on track ${target.trackId}`,
      });
    });
    return out;
  }, [doc.lfos]);

  const rows = useMemo(() => {
    const out: SceneFxRow[] = [];
    for (const track of tracks) {
      if (!("effects" in track) || !Array.isArray(track.effects)) continue;
      for (const fx of track.effects) {
        if (fx.type === "skrutka") {
          out.push({
            key: `${track.id}:${fx.id}`,
            trackId: track.id,
            trackName: track.name,
            fxId: fx.id,
            kind: "twist",
            effectName: EFFECT_DEFS.skrutka.name,
            pairId: findTwistScenePair(readTwistCurvesState(fx.deviceState)?.slots)?.id ?? null,
            bound: twistMorphIntensityBound(doc, track.id, fx.id),
          });
        } else if (fx.type === "bassHarmonic") {
          out.push({
            key: `${track.id}:${fx.id}`,
            trackId: track.id,
            trackName: track.name,
            fxId: fx.id,
            kind: "grow",
            effectName: EFFECT_DEFS.bassHarmonic.name,
            pairId: findKorenScenePair(readKorenSceneState(fx.deviceState)?.slots)?.id ?? null,
            bound: korenSceneIntensityBound(doc, track.id, fx.id),
          });
        }
      }
    }
    return out;
  }, [tracks, doc]);

  if (scenes.length === 0 && rows.length === 0) return null;

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, value ? "0" : "1");
      } catch {
        /* private mode — session-only collapse */
      }
      return !value;
    });
  };

  const applyPair = (row: SceneFxRow, pairId: string) => {
    if (row.kind === "twist") {
      const pair = TWIST_SCENE_PACK.find((candidate) => candidate.id === pairId);
      if (pair) services.store.execute(applyTwistScenePair(doc, row.trackId, row.fxId, pair));
    } else {
      const pair = KOREN_SCENE_PACK.find((candidate) => candidate.id === pairId);
      if (pair) services.store.execute(applyKorenScenePair(doc, row.trackId, row.fxId, pair));
    }
  };

  return (
    <section
      className={`scene-strip${collapsed ? " collapsed" : ""}`}
      aria-label="Scene intensity and scene packs"
      title="Scene intensity + the TWIST/GROW scene pairs in one place"
    >
      <button
        type="button"
        className="scene-strip-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? "Show the scene strip" : "Hide the scene strip"}
        onClick={toggleCollapsed}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> SCENE
      </button>
      {!collapsed && (
        <>
          <div className="scene-strip-scene">
            <span className="scene-strip-name" title="The scene whose static intensity this slider edits">
              {scene ? scene.name : "NO SCENE"}
            </span>
            <div className="scene-strip-intensity">
              <Slider
                compact
                label="Scene intensity"
                value={scene?.intensity ?? 0.7}
                min={0}
                max={1}
                defaultValue={0.7}
                format={(value) => `${Math.round(value * 100)}%`}
                disabled={!scene}
                onCommit={(value) => {
                  if (scene) services.store.execute(setSceneIntensity(doc, scene.id, value));
                }}
              />
            </div>
            <span
              className="scene-strip-chip"
              title={
                scene?.intensityCurve?.length
                  ? "This scene has an intensity curve — the arrangement lane shapes playback; the slider is the static fallback"
                  : "The scene's static intensity drives every SCENE-INTENSITY binding"
              }
            >
              {scene?.intensityCurve?.length ? "CURVE" : "STATIC"}
            </span>
          </div>
          <div className="scene-strip-fx">
            {rows.map((row) => {
              const pairs = row.kind === "twist" ? TWIST_SCENE_PACK : KOREN_SCENE_PACK;
              return (
                <div className="scene-strip-row" key={row.key}>
                  <button
                    type="button"
                    className={`scene-strip-track${selection.trackIds.includes(row.trackId) ? " selected" : ""}`}
                    aria-pressed={selection.trackIds.includes(row.trackId)}
                    title={`Select ${row.trackName}`}
                    onClick={() =>
                      selectionStore.setTracks(
                        [row.trackId],
                        "replace",
                        tracks.map((t) => t.id),
                      )
                    }
                  >
                    {row.trackName}
                  </button>
                  <span className={`scene-strip-kind ${row.kind}`}>{row.effectName}</span>
                  <select
                    className="scene-strip-pair"
                    aria-label={`${row.effectName} scene pair on ${row.trackName}`}
                    value={row.pairId ?? ""}
                    title="Curated A/B pairs — the intro scene leans A, the drop lands B"
                    onChange={(event) => applyPair(row, event.target.value)}
                  >
                    {!row.pairId && <option value="">CUSTOM</option>}
                    {pairs.map((pair) => (
                      <option key={pair.id} value={pair.id}>
                        {pair.genre} — {pair.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="scene-strip-pair scene-strip-pair-scene"
                    aria-label={`Scene pair for ${row.effectName} on ${row.trackName}`}
                    value={scene?.packs?.[row.fxId] ?? ""}
                    disabled={!scene}
                    title={
                      scene
                        ? `Which pair "${scene.name}" plays — the effect switches at the clip boundary; empty = the effect's own applied pair`
                        : "Select a scene first"
                    }
                    onChange={(event) => {
                      if (!scene) return;
                      const value = event.target.value;
                      services.store.execute(setScenePack(doc, scene.id, row.fxId, value === "" ? null : value));
                    }}
                  >
                    <option value="">—</option>
                    {pairs.map((pair) => (
                      <option key={pair.id} value={pair.id}>
                        {pair.genre} — {pair.label}
                      </option>
                    ))}
                  </select>
                  {row.bound && (
                    <span className="scene-strip-chip" title="This effect rides the scene intensity">
                      SCENE
                    </span>
                  )}
                </div>
              );
            })}
            {rows.length === 0 && <span className="scene-strip-empty">No TWIST or GROW devices in the project</span>}
          </div>
          {macros.length > 0 && (
            <div className="scene-strip-macros" role="group" aria-label="Scene macros">
              {macros.map((macro) => {
                const pinned = scene?.macros?.[macro.id];
                const isPinned = typeof pinned === "number";
                const effective = isPinned ? pinned : macro.value;
                return (
                  <div className={`scene-strip-macro${isPinned ? " pinned" : ""}`} key={macro.id}>
                    <span
                      className="scene-strip-macro-name"
                      title={
                        isPinned
                          ? `${macro.name} is PINNED to this scene — every macro-sourced mapping follows the scene (× clears)`
                          : `${macro.name} follows its live value until you move it here — moving pins it to this scene`
                      }
                    >
                      {macro.name}
                    </span>
                    <div className="scene-strip-macro-slider">
                      <Slider
                        compact
                        label={`Scene macro ${macro.name}`}
                        value={effective}
                        min={0}
                        max={1}
                        defaultValue={0.5}
                        format={formatMacroValue}
                        disabled={!scene}
                        onCommit={(value) => {
                          if (scene) services.store.execute(setSceneMacro(doc, scene.id, macro.id, value));
                        }}
                      />
                    </div>
                    {isPinned && (
                      <button
                        type="button"
                        className="scene-strip-macro-clear"
                        title={`Clear the ${macro.name} pin — the macro returns to its live value`}
                        onClick={() => {
                          if (scene) services.store.execute(setSceneMacro(doc, scene.id, macro.id, null));
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {ccMappings.length > 0 && (
            <div className="scene-strip-cc" role="group" aria-label="Scene MIDI CC remaps">
              {ccMappings.map((mapping) => {
                const allowList = scene?.ccRemaps;
                const activeForScene = !allowList || allowList.includes(mapping.id);
                const override = scene?.ccOverrides?.[mapping.id];
                const effectiveCc = typeof override?.ccNumber === "number" ? override.ccNumber : mapping.ccNumber;
                const effectiveChannel =
                  typeof override?.channel === "number" ? override.channel : (mapping.channel ?? 0);
                const label = `${mapping.macroName} ← CC${mapping.ccNumber}${
                  mapping.channel !== undefined ? ` ch${mapping.channel}` : ""
                }`;
                return (
                  <div
                    key={mapping.id}
                    className={`scene-strip-cc-item${activeForScene ? "" : " muted"}`}
                    title={
                      activeForScene
                        ? `${label} is armed in this scene`
                        : `${label} is disarmed in this scene — tick to arm it`
                    }
                  >
                    <label className="scene-strip-cc-toggle" title={label}>
                      <input
                        type="checkbox"
                        checked={activeForScene}
                        disabled={!scene}
                        aria-label={`${label} armed in this scene`}
                        onChange={(event) => {
                          if (scene)
                            services.store.execute(setSceneCcRemap(doc, scene.id, mapping.id, event.target.checked));
                        }}
                      />
                      <span>{label}</span>
                    </label>
                    <label
                      className="scene-strip-cc-field"
                      title={`CC number this scene listens on (the mapping's own: ${mapping.ccNumber}) — type the mapping's own number back to clear`}
                    >
                      <span>CC</span>
                      <NumericDraftInput
                        className="scene-strip-cc-number"
                        value={effectiveCc}
                        min={0}
                        max={127}
                        step={1}
                        disabled={!scene}
                        aria-label={`CC number for ${label} in this scene`}
                        onCommit={(ccNumber) => {
                          if (scene)
                            services.store.execute(setSceneCcOverride(doc, scene.id, mapping.id, { ccNumber }));
                        }}
                      />
                    </label>
                    <label
                      className="scene-strip-cc-field"
                      title={`MIDI channel this scene listens on — 0 = any (the mapping's own: ${
                        mapping.channel ?? "any"
                      })`}
                    >
                      <span>CH</span>
                      <NumericDraftInput
                        className="scene-strip-cc-number"
                        value={effectiveChannel}
                        min={0}
                        max={16}
                        step={1}
                        disabled={!scene}
                        aria-label={`Channel for ${label} in this scene`}
                        onCommit={(channel) => {
                          if (scene)
                            services.store.execute(
                              setSceneCcOverride(doc, scene.id, mapping.id, {
                                channel: channel === 0 ? null : channel,
                              }),
                            );
                        }}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          {modulatorRows.length > 0 && (
            <div className="scene-strip-modulators" role="group" aria-label="Scene modulator patterns">
              {modulatorRows.map((row) => {
                const pinned = scene?.modulators?.[row.id];
                const isPinned = !!pinned && (pinned.steps !== undefined || pinned.seed !== undefined);
                const detail = pinned?.steps
                  ? `STEPS ×${pinned.steps.length}`
                  : pinned?.seed
                    ? `SEED ${pinned.seed.slice(0, 6)}…`
                    : "";
                return (
                  <span
                    key={row.id}
                    className={`scene-strip-modulator${isPinned ? " pinned" : ""}`}
                    title={`${row.label} ${row.title} — pin the CURRENT ${
                      row.kind === "step" ? "step pattern" : "random stream"
                    } to this scene`}
                  >
                    <span className="scene-strip-modulator-label">{row.label}</span>
                    {isPinned ? (
                      <>
                        <span className="scene-strip-modulator-detail">{detail}</span>
                        <button
                          type="button"
                          className="scene-strip-macro-clear"
                          title="Clear the scene pin — the modulator returns to its own pattern"
                          onClick={() => {
                            if (scene)
                              services.store.execute(
                                setSceneModulatorPattern(doc, scene.id, row.id, { steps: null, seed: null }),
                              );
                          }}
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="scene-strip-pin"
                        disabled={!scene}
                        title={`Pin the current ${row.kind === "step" ? "step pattern" : "random stream"} to this scene`}
                        onClick={() => {
                          if (!scene) return;
                          const lfo = doc.lfos.find((candidate) => candidate.id === row.id);
                          if (!lfo) return;
                          if (row.kind === "step") {
                            services.store.execute(
                              setSceneModulatorPattern(doc, scene.id, row.id, { steps: [...stepsOf(lfo)] }),
                            );
                          } else {
                            const seed =
                              typeof lfo.seed === "string" && lfo.seed.length > 0
                                ? lfo.seed
                                : `${lfo.id}:scene:${scene.id}`;
                            services.store.execute(setSceneModulatorPattern(doc, scene.id, row.id, { seed }));
                          }
                        }}
                      >
                        PIN
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
