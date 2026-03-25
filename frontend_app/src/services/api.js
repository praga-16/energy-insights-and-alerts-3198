/**
 * Lightweight REST client for Energy Insights & Alerts.
 * Uses Create React App env vars:
 * - REACT_APP_API_BASE (preferred)
 * - REACT_APP_BACKEND_URL (fallback)
 */

const DEFAULT_TIMEOUT_MS = 15000;

function getEnv(name, fallback = "") {
  // CRA inlines process.env at build time; keep access centralized.
  return (process.env[name] || fallback || "").trim();
}

// PUBLIC_INTERFACE
export function getApiBaseUrl() {
  /**
   * Returns the configured base URL for REST API calls.
   * Falls back to same-origin (empty string) when not configured.
   */
  return getEnv("REACT_APP_API_BASE") || getEnv("REACT_APP_BACKEND_URL") || "";
}

function buildUrl(path) {
  const base = getApiBaseUrl();
  if (!path) return base || "";
  if (!base) return path; // same-origin
  return `${base.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

async function parseJsonSafe(resp) {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestJson(path, { method = "GET", body, headers } = {}) {
  const url = buildUrl(path);
  const resp = await fetchWithTimeout(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!resp.ok) {
    const payload = await parseJsonSafe(resp);
    const msg = payload?.detail || payload?.message || resp.statusText || "Request failed";
    const err = new Error(`${method} ${url} -> ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.payload = payload;
    throw err;
  }

  return parseJsonSafe(resp);
}

// PUBLIC_INTERFACE
export async function healthCheck() {
  /** Calls backend health endpoint (best-effort). */
  const healthPath = getEnv("REACT_APP_HEALTHCHECK_PATH", "/");
  return requestJson(healthPath);
}

// PUBLIC_INTERFACE
export async function getDashboardSnapshot() {
  /**
   * Returns a normalized dashboard payload.
   * Note: backend OpenAPI currently only exposes `/` so we provide mock data
   * until backend endpoints are implemented.
   */
  // Try a future endpoint first; if it fails, return mock.
  try {
    const data = await requestJson("/api/dashboard");
    return data;
  } catch {
    // Mock dataset for UI continuity
    const now = Date.now();
    const points = Array.from({ length: 24 }, (_, i) => {
      const hour = 23 - i;
      const ts = now - hour * 60 * 60 * 1000;
      const base = 120 + 20 * Math.sin((i / 24) * Math.PI * 2);
      const noise = (Math.random() - 0.5) * 10;
      return { ts, kwh: Math.max(60, Math.round(base + noise)) };
    });

    return {
      site: { name: "Acme HQ", id: "site_001" },
      range: "24h",
      kpis: {
        total_kwh: points.reduce((a, p) => a + p.kwh, 0),
        avg_kw: Math.round((points.reduce((a, p) => a + p.kwh, 0) / 24) * 10) / 10,
        peak_kw: Math.max(...points.map((p) => p.kwh)),
        anomaly_count: 2,
      },
      series: points,
      insights: [
        { id: "ins_1", title: "Evening baseline drift", detail: "After 7pm, load stays ~12% above typical." },
        { id: "ins_2", title: "Weekend HVAC cycling", detail: "Short-cycling detected on Sat 2–4pm." },
      ],
    };
  }
}

// PUBLIC_INTERFACE
export async function getAlerts() {
  /**
   * Fetches recent alerts from backend; returns mock data if endpoint is missing.
   */
  try {
    const data = await requestJson("/api/alerts");
    return Array.isArray(data) ? data : data?.items || [];
  } catch {
    const now = Date.now();
    return [
      {
        id: "al_1",
        severity: "high",
        title: "Spike detected",
        message: "Demand exceeded threshold by 28% for 15 minutes.",
        ts: now - 12 * 60 * 1000,
        acknowledged: false,
      },
      {
        id: "al_2",
        severity: "medium",
        title: "Off-hours usage",
        message: "Sustained load detected outside operating hours.",
        ts: now - 55 * 60 * 1000,
        acknowledged: false,
      },
    ];
  }
}

// PUBLIC_INTERFACE
export async function acknowledgeAlert(alertId) {
  /**
   * Best-effort acknowledge call; if backend not available, returns a local success result.
   */
  if (!alertId) throw new Error("alertId is required");
  try {
    return await requestJson(`/api/alerts/${encodeURIComponent(alertId)}/ack`, { method: "POST" });
  } catch {
    return { ok: true, id: alertId };
  }
}
