/**
 * SEND-TO-KYX — background service worker (MV3).
 *
 * Right-click any audio (element, link, or the page's main media) → the
 * worker fetches the bytes itself (host permissions bypass page CORS),
 * base64-encodes them, and POSTs to the KYX intake endpoint on the user's
 * own collab server. The studio's IntakeTray polls that list and imports
 * with one click. Local-only: the default endpoint is 127.0.0.1:1234,
 * changeable in the options page. Nothing leaves the machine.
 */

const DEFAULT_INTAKE = "http://127.0.0.1:1234/api/intake";
const MAX_BYTES = 6 * 1024 * 1024; // matches the server's ~6.7 MB base64 budget

const MENU_ROOT = "kyx-send-root";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ROOT,
      title: "Send to KYX",
      contexts: ["audio", "video", "link", "page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ROOT) return;
  const url = info.srcUrl || info.linkUrl || info.pageUrl || "";
  if (!url) return;
  void sendToKyx(url, tab);
});

async function intakeUrl() {
  const stored = await chrome.storage.local.get("intakeUrl");
  return (stored.intakeUrl || DEFAULT_INTAKE).replace(/\/$/, "");
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: color || "#22c55e" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

async function sendToKyx(url, tab) {
  await setBadge("…", "#eab308");
  const nameFromUrl = (() => {
    try {
      const path = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "web-audio";
      return decodeURIComponent(path).replace(/[?#].*$/, "") || "web-audio";
    } catch {
      return "web-audio";
    }
  })();

  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`source responded ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES)
      throw new Error(`audio too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB, cap 6 MB)`);
    const dataB64 = arrayBufferToBase64(buffer);

    const res = await fetch(await intakeUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameFromUrl,
        dataB64,
        sourceUrl: url.slice(0, 500),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `intake responded ${res.status}`);
    }
    await setBadge("✓");
  } catch (err) {
    console.warn("[send-to-kyx] failed:", err);
    await setBadge("✗", "#ef4444");
    // Best-effort visible feedback: open the studio intake isn't possible
    // from the worker, so surface the reason on the badge console + title.
    chrome.action.setTitle({ title: `Send to KYX — last error: ${String(err).slice(0, 120)}` });
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
