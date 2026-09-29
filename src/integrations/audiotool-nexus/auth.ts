/**
 * Bounded OAuth popup handling for the Audiotool Nexus connector.
 *
 * `@audiotool/nexus`'s `audiotoolPopup()` settles on exactly two events: a
 * `postMessage` from `https://accounts.audiotool.com`, or `popup.closed`. It
 * has no timeout of its own. When the accounts service cannot deliver the
 * message back to `target_origin` — an unregistered Redirect URI origin, or an
 * application without the `project:write` scope — the popup stays open and the
 * promise never settles.
 *
 * Without a bound here, the caller holds its busy flag forever and every control
 * in the export panel (including close) stays disabled, so the only recovery is
 * a full page reload. These helpers put an upper bound on the wait and turn the
 * SDK's opaque error strings into an actionable message.
 */

/** Upper bound on the popup wait. Generous enough for password + MFA. */
export const POPUP_AUTH_TIMEOUT_MS = 180_000;

/**
 * Upper bound on opening a project and on its first sync.
 *
 * The SDK's gateway reconnects on a failed ping, so a document opened while the
 * network is down keeps retrying instead of failing — which means the promise
 * `start()` awaits can stay pending indefinitely. The bound is deliberately
 * treated as "slow", not "broken": the session is kept and the existing
 * not-connected state holds the write button until the gateway links up.
 */
export const CONNECT_TIMEOUT_MS = 45_000;

/** Rejection produced by {@link withTimeout} when the wait elapses. */
export class AudiotoolTimeoutError extends Error {
  constructor(ms: number) {
    super(`Audiotool operation did not complete within ${Math.round(ms / 1000)}s.`);
    this.name = "AudiotoolTimeoutError";
  }
}

/**
 * Reject with a timeout error if `work` has not settled within `ms`.
 *
 * The timer is always cleared once the work settles, so a fast path leaves no
 * pending handle behind. The first outcome wins: a late settlement after a
 * timeout is ignored rather than re-settling the promise.
 */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AudiotoolTimeoutError(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/**
 * Turn an SDK/OAuth error message into a message that names the actual fix.
 *
 * The SDK flattens failures into a single string (`"<code>: <description>"`), so
 * the code is matched first and the description is only a fallback signal. The
 * ordering matters: `invalid_scope` has to be tested before the generic OAuth
 * fallbacks, and the popup-lifecycle strings before anything else, because they
 * mean the user simply has to interact with the window.
 */
export function describeAuthFailure(message: string): string {
  const text = message.toLowerCase();

  if (text.includes("popup was blocked")) {
    return "Prehliadač zablokoval prihlasovacie okno. Povoľ pop-upy pre túto stránku a skús to znova.";
  }
  if (text.includes("popup was closed")) {
    return "Prihlasovacie okno si zavrel skôr, než prihlásenie stihlo dokončiť. Spusť to znova a okno nechaj otvorené.";
  }
  if (text.includes("invalid_scope") || text.includes("scope")) {
    return (
      "Audiotool aplikácii chýba povolenie project:write. V developer.audiotool.com/applications pridaj scope " +
      "project:write k tejto aplikácii a potom sa znova prihlás."
    );
  }
  if (text.includes("access_denied")) {
    return "Prístup si v Audiotole odmietol. Ak si to nepotvrdil, spusť prihlásenie znova a klikni na povolenie.";
  }
  if (text.includes("invalid_client")) {
    return "Client ID nie je platný alebo aplikácia na developer.audiotool.com nie je registrovaná. Skontroluj hodnotu VITE_AUDIOTOOL_NEXUS_CLIENT_ID.";
  }
  if (text.includes("invalid_grant")) {
    return "Prihlasovací kód vypršal, skôr než sa vymenil za token. Spusť prihlásenie znova.";
  }
  if (text.includes("invalid_state")) {
    return "Prihlasovací sedlo sa nezhodlo s oknom, z ktorého bolo otvorené. Spusť prihlásenie znova.";
  }
  if (text.includes("invalid_response")) {
    return "Prihlasovacie okno vrátilo neočakávanú odpoveď. Spusť prihlásenie znova.";
  }
  return "Prihlásenie bolo zrušené alebo zlyhalo. Skontroluj prihlasenie v Audiotole a skús to znova.";
}

/**
 * Message for a popup that never came back, which is the failure mode a
 * misconfigured Redirect URI origin produces: the accounts service renders the
 * callback but cannot post the result to an origin it does not recognise, and
 * the SDK waits forever because the popup itself is still open.
 */
export function describeAuthTimeout(origin: string): string {
  return (
    `Audiotool sa do ${Math.round(POPUP_AUTH_TIMEOUT_MS / 1000)} s nevrátil — prihlasovacie okno zrejme čaká na potvrdenie, ` +
    `ktoré nikdy nepríde. Najčastejšia príčina je origin ${origin}, ktorý v aplikácii na developer.audiotool.com/applications ` +
    `nemá registrovaný Redirect URI, alebo aplikácia nemá povolený scope project:write. Zavri okno a skús to znova po ` +
    `oprave registrácie.`
  );
}

/**
 * Message for a project that opened but has not finished its first sync.
 *
 * The session is intentionally kept: the gateway reconnects on its own, so the
 * panel recovers by itself once the network returns. Saying so beats reporting
 * a failure the user cannot act on.
 */
export function describeConnectTimeout(): string {
  return (
    `Audiotool projekt sa otvoril, ale prvý sync trvá dlhšie než ${Math.round(CONNECT_TIMEOUT_MS / 1000)} s. ` +
    `Prihlásenie ostáva aktívne a pokus sa zopakuje sám; zápis sa odomkne, keď sa spojenie nadviaže. Skontroluj ` +
    `projekt v Audiotole medzitým.`
  );
}
