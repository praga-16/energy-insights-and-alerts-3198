/**
 * Realtime alerts transport:
 * - Prefer WebSocket using REACT_APP_WS_URL
 * - Fallback to polling getAlerts()
 */

import { getAlerts } from "./api";

function getWsUrl() {
  return (process.env.REACT_APP_WS_URL || "").trim();
}

/**
 * Expected message format (flexible):
 * - { type: "alert", data: {...} }
 * - { alert: {...} }
 * - {...alert fields...}
 */
function normalizeIncomingAlert(msg) {
  if (!msg) return null;
  if (msg.type === "alert" && msg.data) return msg.data;
  if (msg.alert) return msg.alert;
  if (msg.id && msg.title) return msg;
  return null;
}

// PUBLIC_INTERFACE
export function createRealtimeAlerts({
  onAlert,
  onStatus,
  pollingIntervalMs = 15000,
} = {}) {
  /**
   * Creates a realtime alerts subscription.
   * Returns: { start(), stop() }
   */
  let ws = null;
  let stopped = false;
  let pollTimer = null;
  let reconnectTimer = null;
  let lastPollIds = new Set();

  const safeOnStatus = (s) => {
    try {
      onStatus && onStatus(s);
    } catch {
      // ignore UI handler errors
    }
  };

  const safeOnAlert = (a) => {
    try {
      onAlert && onAlert(a);
    } catch {
      // ignore UI handler errors
    }
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    if (pollTimer) return;
    safeOnStatus({ mode: "polling", state: "connecting" });
    pollTimer = setInterval(async () => {
      try {
        const alerts = await getAlerts();
        // Emit only new ids
        const newOnes = [];
        for (const a of alerts) {
          if (a?.id && !lastPollIds.has(a.id)) newOnes.push(a);
        }
        // Refresh cache to avoid unbounded growth (keep last 200)
        const next = new Set(alerts.map((a) => a?.id).filter(Boolean).slice(0, 200));
        lastPollIds = next;

        newOnes.forEach((a) => safeOnAlert(a));
        safeOnStatus({ mode: "polling", state: "open" });
      } catch (e) {
        safeOnStatus({ mode: "polling", state: "error", error: e?.message || String(e) });
      }
    }, pollingIntervalMs);

    // Run immediately
    (async () => {
      try {
        const alerts = await getAlerts();
        lastPollIds = new Set(alerts.map((a) => a?.id).filter(Boolean).slice(0, 200));
        safeOnStatus({ mode: "polling", state: "open" });
      } catch (e) {
        safeOnStatus({ mode: "polling", state: "error", error: e?.message || String(e) });
      }
    })();
  };

  const cleanupWs = () => {
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    ws = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const connectWs = () => {
    const url = getWsUrl();
    if (!url) return false;

    safeOnStatus({ mode: "ws", state: "connecting", url });
    try {
      ws = new WebSocket(url);
    } catch (e) {
      safeOnStatus({ mode: "ws", state: "error", error: e?.message || String(e) });
      cleanupWs();
      return false;
    }

    ws.onopen = () => {
      safeOnStatus({ mode: "ws", state: "open" });
    };

    ws.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(evt.data);
        const alert = normalizeIncomingAlert(parsed);
        if (alert) safeOnAlert(alert);
      } catch {
        // ignore non-json messages
      }
    };

    ws.onerror = () => {
      safeOnStatus({ mode: "ws", state: "error", error: "WebSocket error" });
    };

    ws.onclose = () => {
      if (stopped) return;
      safeOnStatus({ mode: "ws", state: "closed" });

      // Reconnect with mild backoff, otherwise fallback to polling if repeatedly failing.
      cleanupWs();
      reconnectTimer = setTimeout(() => {
        if (stopped) return;
        const ok = connectWs();
        if (!ok) startPolling();
      }, 1200);
    };

    return true;
  };

  return {
    // PUBLIC_INTERFACE
    start() {
      /** Starts realtime: websocket when available, otherwise polling. */
      stopped = false;
      stopPolling();
      cleanupWs();

      const ok = connectWs();
      if (!ok) startPolling();
    },

    // PUBLIC_INTERFACE
    stop() {
      /** Stops realtime transports and timers. */
      stopped = true;
      stopPolling();
      cleanupWs();
      safeOnStatus({ mode: "off", state: "closed" });
    },
  };
}
