/**
 * Add the document policies Electron needs before renderer code can create
 * SharedArrayBuffers for the bounded native PCM rings. Keeping this on the
 * app:// protocol leaves the browser/PWA security policy unchanged.
 */
function withAudioIsolationHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

module.exports = { withAudioIsolationHeaders };
