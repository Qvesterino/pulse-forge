/**
 * yDocBridge — decouples the pure command factories from the yjs-backed
 * helpers without pulling yjs into the main bundle.
 *
 * commands.ts creates Command objects with `applyToYDoc` callbacks, but only
 * YDocStore (the collab chunk, which already ships yjs) ever invokes them.
 * The helpers themselves live in yDocHelpers.ts next to yjs; YDocStore
 * registers them here at construction time. In a plain ProjectStore session
 * the bridge stays empty and nothing from yjs is ever loaded.
 */

export interface YDocHelpers {
  yToggleStep: (yMap: unknown, patternId: string, padId: string, stepIndex: number, defaultVelocity?: number) => void;
  ySetStepVelocity: (
    yMap: unknown,
    patternId: string,
    padId: string,
    stepIndex: number,
    velocity: number,
  ) => void;
  ySetPatternField?: (yMap: unknown, patternId: string, field: string, value: unknown) => void;
  ySetTrackField?: (yMap: unknown, trackId: string, field: string, value: unknown) => void;
  ySetProjectField?: (yMap: unknown, field: string, value: unknown) => void;
  /** Fresh empty Y.Map — for commands that build nested Y structures. */
  createYMap?: () => unknown;
}

let helpers: YDocHelpers | null = null;

/** Called by YDocStore when the collab store is created. */
export function registerYDocHelpers(impl: YDocHelpers): void {
  helpers = impl;
}

/** Apply-to-YDoc callbacks use this; null means no collab store exists. */
export function getYDocHelpers(): YDocHelpers | null {
  return helpers;
}
