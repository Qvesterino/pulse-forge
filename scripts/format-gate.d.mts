/**
 * Type declarations for scripts/format-gate.mjs.
 *
 * The gate is plain JavaScript on purpose: it runs before anything else in the
 * toolchain (it must be able to report an unformatted tree without a build
 * step), and the repository already keeps `.mjs` scripts with sibling
 * `.d.mts` declarations for exactly this reason.
 */

export const REPO_ROOT: string;

export function parseScope(scope: string): string[];

export function resolveScopeFiles(scope: string[], trackedPaths: string[]): string[];

export function trackedFiles(cwd?: string): string[];

export function buildGateFileList(
  scope: string[],
  trackedPaths: string[],
  exists?: (file: string) => boolean,
): string[];

export function batchFiles(files: string[], budget?: number): string[][];
