/**
 * optional-local-services.mjs — ONE list of the local services a KYX browser
 * session may probe and live without.
 *
 *   1234  — the local collab/gallery/QMR bridge (the collab relay and the
 *           intake API). Collaboration and the public gallery are opt-in; the
 *           app boots, edits and renders with the bridge absent.
 *   11434 — a local Ollama runtime for the local LLM intent model. It is
 *           gated by a kill switch AND by a probe: "the probe is the real
 *           gate" (src/intent/model-ollama.ts) — no Ollama means the local
 *           model is simply unavailable, not broken.
 *
 * Both are LOCAL and OPTIONAL, and a browser session on localhost probes both.
 * A refusal is therefore not a boot failure — but ONLY when EVERY failed
 * request went to one of them. A missing shipped asset, a broken chunk or a
 * real network fault still keeps the gate red, so this list cannot hide one.
 *
 * Two browser gates use this contract (scripts/verify-browser.mjs for the dev
 * server, scripts/verify-production-browser.mjs for the built dist). They
 * share ONE owner, because two copies of this list would drift exactly like
 * the numbers this repo keeps fixing.
 */
export const OPTIONAL_LOCAL_SERVICE_URL = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost):(?:1234|11434)(?:\/|$)/;

/** True when the URL belongs to an optional local service. */
export function isOptionalLocalServiceUrl(url) {
  return typeof url === "string" && OPTIONAL_LOCAL_SERVICE_URL.test(url);
}

/**
 * True when a console error can be attributed to an optional local service.
 *
 * Two ways to attribute it:
 *   1. by the message LOCATION — for a failed resource, Chromium reports the
 *      URL of the resource that failed;
 *   2. by the URL a refused WebSocket carries in its own text — a WebSocket
 *      handshake is not an HTTP request, so `requestfailed` never reports it
 *      and the console text is the only place its URL exists.
 */
export function isOptionalLocalServiceError(text, url) {
  if (isOptionalLocalServiceUrl(url)) return true;
  const socket = /WebSocket connection to '([^']+)' failed/i.exec(String(text ?? ""));
  return socket ? isOptionalLocalServiceUrl(socket[1]) : false;
}
