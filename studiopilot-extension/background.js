/* StudioPilot - background service worker.
 * The content scripts own the WebSocket to the bridge, so this worker stays
 * minimal: it answers popup status pings via the bridge's HTTP status endpoint
 * so the popup can show health even when no AI tab is open.
 */
"use strict";

const STATUS_URL = "http://127.0.0.1:17655/api/status";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "bridge_status") {
    fetch(STATUS_URL, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async response
  }
  return false;
});
