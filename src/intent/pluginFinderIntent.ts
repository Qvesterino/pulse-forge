/**
 * Plugin finder intent (ADR 0016 intent surface): "aké clapy mám?" /
 * "what clap plugins do I have" / "scan my claps" — routes to the desktop
 * CLAP scan instead of the generation pipeline. Detection is deliberately
 * clap-stem-scoped (the format's own name in this app); broader "plugins"
 * questions stay unanswered until VST hosting ever exists.
 *
 * Execution is context-honest: the scan lives in the desktop shell
 * (window.kyxDesktop.clap.scan — crash-isolated probe per file); the web
 * build has no native access and says so instead of pretending.
 */

export interface PluginFinderIntent {
  kind: "list-claps";
}

const deaccent = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const CLAP_STEM = /\bclap\w*\b/;

/** Detect a plugin-finder intent in free text. Null = not this feature. */
export function parsePluginFinderIntent(text: string): PluginFinderIntent | null {
  const lower = deaccent(text);
  if (!lower.trim()) return null;
  if (!CLAP_STEM.test(lower)) return null;
  return { kind: "list-claps" };
}
