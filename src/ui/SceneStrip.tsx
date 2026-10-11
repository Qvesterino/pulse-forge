import { useMemo, useState } from "react";
import { useActivePatternId, useScenes, useSelectionStore, useServices, useTracks } from "./context";
import {
  applyKorenScenePair,
  applyTwistScenePair,
  korenSceneIntensityBound,
  setSceneIntensity,
  twistMorphIntensityBound,
} from "../commands/commands";
import { EFFECT_DEFS } from "../effects/registry";
import { readTwistCurvesState } from "../effects/skrutka-curves";
import { TWIST_SCENE_PACK, findTwistScenePair } from "../effects/skrutka-scene-pack";
import { readKorenSceneState } from "../effects/koren-scene";
import { KOREN_SCENE_PACK, findKorenScenePair } from "../effects/koren-scene-pack";
import { Slider } from "./controls";

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
 * panels use. The track name selects the strip's track so a row is one click
 * from the device in the mixer.
 */
export function SceneStrip({ sceneId }: { sceneId?: string }) {
  const services = useServices();
  const tracks = useTracks();
  const scenes = useScenes();
  const activePatternId = useActivePatternId();
  const selectionStore = useSelectionStore();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const doc = services.store.getDoc();

  const scene = useMemo(() => {
    if (sceneId) {
      const selected = scenes.find((candidate) => candidate.id === sceneId);
      if (selected) return selected;
    }
    return scenes.find((candidate) => candidate.patternId === activePatternId) ?? scenes[0] ?? null;
  }, [sceneId, scenes, activePatternId]);

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
                    className="scene-strip-track"
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
        </>
      )}
    </section>
  );
}
