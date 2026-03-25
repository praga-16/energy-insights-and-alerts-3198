import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { acknowledgeAlert, getAlerts, getApiBaseUrl, getDashboardSnapshot, healthCheck } from "./services/api";
import { createRealtimeAlerts } from "./services/realtime";

function formatKwh(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
}

function formatKw(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v);
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" });
  } catch {
    return "";
  }
}

function buildSparklinePath(points, w, h, pad = 10) {
  if (!points?.length) return "";
  const values = points.map((p) => p.kwh);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);

  const xStep = (w - pad * 2) / Math.max(1, points.length - 1);
  const mapX = (i) => pad + i * xStep;
  const mapY = (v) => {
    const t = (v - min) / span;
    return pad + (1 - t) * (h - pad * 2);
  };

  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${mapX(i).toFixed(2)} ${mapY(p.kwh).toFixed(2)}`)
    .join(" ");
}

// PUBLIC_INTERFACE
function App() {
  const [site, setSite] = useState("Acme HQ");
  const [range, setRange] = useState("24h");
  const [threshold, setThreshold] = useState(180);

  const [snapshot, setSnapshot] = useState(null);
  const [alerts, setAlertsState] = useState([]);
  const [transport, setTransport] = useState({ mode: "off", state: "closed" });
  const [apiStatus, setApiStatus] = useState({ ok: null, message: "Checking…" });

  const realtimeRef = useRef(null);

  const sparkPath = useMemo(() => {
    const series = snapshot?.series || [];
    return buildSparklinePath(series, 900, 220, 14);
  }, [snapshot]);

  const aboveThresholdCount = useMemo(() => {
    const series = snapshot?.series || [];
    return series.filter((p) => p.kwh >= threshold).length;
  }, [snapshot, threshold]);

  const refresh = async () => {
    const data = await getDashboardSnapshot({ site, range, threshold });
    setSnapshot(data);
  };

  const refreshAlerts = async () => {
    const data = await getAlerts();
    setAlertsState((prev) => {
      // Keep acknowledgement state locally if backend missing
      const prevAck = new Map(prev.map((a) => [a.id, a.acknowledged]));
      return (data || []).map((a) => ({ ...a, acknowledged: prevAck.get(a.id) ?? a.acknowledged ?? false }));
    });
  };

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        await healthCheck();
        if (!mounted) return;
        setApiStatus({ ok: true, message: "Backend reachable" });
      } catch (e) {
        if (!mounted) return;
        setApiStatus({ ok: false, message: e?.message || "Backend unavailable (using mock data)" });
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    refresh();
    refreshAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, range]);

  useEffect(() => {
    // Start realtime subscription once and keep it through app lifetime.
    realtimeRef.current = createRealtimeAlerts({
      onAlert: (a) => {
        // Merge into list; newest first
        setAlertsState((prev) => {
          const next = [a, ...prev.filter((x) => x?.id !== a?.id)];
          return next.slice(0, 50);
        });
      },
      onStatus: setTransport,
      pollingIntervalMs: 15000,
    });

    realtimeRef.current.start();

    return () => {
      realtimeRef.current?.stop();
      realtimeRef.current = null;
    };
  }, []);

  const ackAlert = async (id) => {
    setAlertsState((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)));
    try {
      await acknowledgeAlert(id);
    } catch {
      // keep local ack
    }
  };

  const apiBase = getApiBaseUrl();

  const transportDotClass =
    transport?.state === "open" ? "ok" : transport?.state === "connecting" ? "warn" : transport?.state === "error" ? "err" : "";

  return (
    <div className="App">
      <div className="topbar" role="banner">
        <div className="topbar-inner">
          <div className="brand" aria-label="Energy Insights & Alerts">
            <div className="brand-badge" aria-hidden="true">
              E
            </div>
            <div className="brand-title">
              <strong>Energy Insights & Alerts</strong>
              <span>Ocean Professional dashboard</span>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="pill" title="Realtime transport">
              <span className={`pill-dot ${transportDotClass}`} />
              <span>
                {transport?.mode === "ws" ? "Realtime WS" : transport?.mode === "polling" ? "Polling" : "Offline"} ·{" "}
                {transport?.state}
              </span>
            </div>
            <div className="pill" title="Backend connectivity">
              <span className={`pill-dot ${apiStatus.ok ? "ok" : apiStatus.ok === false ? "err" : "warn"}`} />
              <span>{apiStatus.message}</span>
            </div>
            <button className="btn btn-primary" onClick={() => refresh()} aria-label="Refresh dashboard data">
              Refresh
            </button>
          </div>
        </div>
      </div>

      <main className="main">
        <div className="layout">
          <aside className="sidebar" aria-label="Filters and configuration">
            <div className="sidebar-header">
              <h2>Filters</h2>
              <p>Choose site, range, and alert threshold.</p>
            </div>

            <div className="sidebar-body">
              <div className="field">
                <label htmlFor="site">Site</label>
                <input
                  id="site"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  placeholder="Site name"
                  aria-label="Site name"
                />
              </div>

              <div className="field">
                <label htmlFor="range">Time range</label>
                <select id="range" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="threshold">Spike threshold (kWh per interval)</label>
                <input
                  id="threshold"
                  type="number"
                  min={0}
                  step={5}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  aria-label="Spike threshold"
                />
              </div>

              <div className="card">
                <div className="card-header">
                  <h3>Environment</h3>
                  <span className="hint">Using REACT_APP_* vars</span>
                </div>
                <div className="card-body">
                  <div className="kpi" style={{ fontSize: 14, fontWeight: 650 }}>
                    API Base
                  </div>
                  <div className="kpi-sub" style={{ wordBreak: "break-all" }}>
                    {apiBase || "(same-origin / not set)"}
                  </div>
                  <div className="kpi-sub" style={{ marginTop: 10 }}>
                    WS URL: {(process.env.REACT_APP_WS_URL || "").trim() || "(not set)"}
                  </div>
                </div>
              </div>
            </div>

            <div className="sidebar-footer">
              <button className="btn" onClick={() => refreshAlerts()} aria-label="Refresh alerts list">
                Refresh alerts
              </button>
              <button
                className="btn"
                onClick={() => {
                  realtimeRef.current?.stop();
                  realtimeRef.current?.start();
                }}
                aria-label="Reconnect realtime"
              >
                Reconnect
              </button>
            </div>
          </aside>

          <section className="content" aria-label="Dashboard content">
            <div className="grid-3" aria-label="Key performance indicators">
              <div className="card">
                <div className="card-header">
                  <h3>Total energy</h3>
                  <span className="hint">{snapshot?.range || "—"}</span>
                </div>
                <div className="card-body">
                  <div className="kpi">{formatKwh(snapshot?.kpis?.total_kwh)} kWh</div>
                  <div className="kpi-sub">Aggregate consumption over selected window.</div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <h3>Average load</h3>
                  <span className="hint">per hour</span>
                </div>
                <div className="card-body">
                  <div className="kpi">{formatKw(snapshot?.kpis?.avg_kw)} kW</div>
                  <div className="kpi-sub">
                    Smooth baseline indicator for operational efficiency tracking.
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <h3>Peak demand</h3>
                  <span className="hint">max interval</span>
                </div>
                <div className="card-body">
                  <div className="kpi">{formatKwh(snapshot?.kpis?.peak_kw)} kWh</div>
                  <div className="kpi-sub">
                    {aboveThresholdCount} intervals above threshold ({threshold}).
                  </div>
                </div>
              </div>
            </div>

            <div className="split">
              <div className="card">
                <div className="chart-title">
                  <h2>Consumption trend</h2>
                  <div className="legend" aria-label="Chart legend">
                    <i aria-hidden="true" /> kWh
                    <span style={{ marginLeft: 10 }}>
                      <i className="secondary" aria-hidden="true" /> threshold
                    </span>
                  </div>
                </div>

                <div className="chart-wrap">
                  <svg className="svg-chart" viewBox="0 0 900 220" role="img" aria-label="Energy consumption line chart">
                    <defs>
                      <linearGradient id="oceanStroke" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="rgba(37, 99, 235, 1)" />
                        <stop offset="100%" stopColor="rgba(37, 99, 235, 0.65)" />
                      </linearGradient>
                      <linearGradient id="oceanFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(37, 99, 235, 0.22)" />
                        <stop offset="100%" stopColor="rgba(37, 99, 235, 0.02)" />
                      </linearGradient>
                    </defs>

                    {/* Threshold line */}
                    {snapshot?.series?.length ? (
                      (() => {
                        const values = snapshot.series.map((p) => p.kwh);
                        const min = Math.min(...values);
                        const max = Math.max(...values);
                        const span = Math.max(1, max - min);
                        const pad = 14;
                        const t = (threshold - min) / span;
                        const y = pad + (1 - t) * (220 - pad * 2);
                        return (
                          <line
                            x1="14"
                            y1={y}
                            x2="886"
                            y2={y}
                            stroke="rgba(245, 158, 11, 0.9)"
                            strokeWidth="2"
                            strokeDasharray="6 6"
                          />
                        );
                      })()
                    ) : null}

                    {/* Area fill */}
                    {sparkPath ? (
                      <path
                        d={`${sparkPath} L 886 206 L 14 206 Z`}
                        fill="url(#oceanFill)"
                        stroke="none"
                        opacity="1"
                      />
                    ) : null}

                    {/* Stroke */}
                    {sparkPath ? (
                      <path d={sparkPath} fill="none" stroke="url(#oceanStroke)" strokeWidth="3" strokeLinecap="round" />
                    ) : null}
                  </svg>

                  <div className="footer-note">
                    Tip: Backend APIs are currently minimal; UI uses mock analytics until `/api/dashboard` and `/api/alerts` exist.
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header">
                  <h3>Insights</h3>
                  <span className="hint">{snapshot?.site?.name || site}</span>
                </div>
                <div className="card-body">
                  <div className="insights">
                    {(snapshot?.insights || []).map((ins) => (
                      <div key={ins.id} className="insight">
                        <strong>{ins.title}</strong>
                        <p>{ins.detail}</p>
                      </div>
                    ))}
                    {!snapshot?.insights?.length ? (
                      <div className="insight">
                        <strong>No insights yet</strong>
                        <p>Once the backend generates analytics, actionable insights will appear here.</p>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="card" aria-label="Alerts">
              <div className="card-header">
                <h3>Alerts</h3>
                <span className="hint">{alerts.length} recent</span>
              </div>
              <div className="card-body">
                <div className="alerts">
                  {alerts.map((a) => (
                    <div key={a.id} className="alert" aria-label={`Alert: ${a.title}`}>
                      <div>
                        <div className="alert-title">
                          <span className={`sev ${a.severity || "low"}`} aria-hidden="true" />
                          <strong>{a.title}</strong>
                          {a.acknowledged ? <span className="badge">Acknowledged</span> : <span className="badge">New</span>}
                        </div>
                        <div className="alert-meta">
                          {a.message}
                          <div style={{ marginTop: 6 }}>Detected: {formatTime(a.ts)}</div>
                        </div>
                      </div>
                      <div className="alert-actions">
                        <button className="btn" disabled={!!a.acknowledged} onClick={() => ackAlert(a.id)}>
                          Acknowledge
                        </button>
                      </div>
                    </div>
                  ))}

                  {!alerts.length ? (
                    <div className="alert">
                      <div>
                        <div className="alert-title">
                          <span className="sev low" aria-hidden="true" />
                          <strong>No alerts</strong>
                        </div>
                        <div className="alert-meta">You’re all clear. Realtime will display anomalies as they arrive.</div>
                      </div>
                      <div className="alert-actions">
                        <span className="badge">OK</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
