"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { saveSeoConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import type { SeoData } from "@/lib/seo";

const fmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n)));
const fmtK = (n: number | null | undefined) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
};
const pct1 = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

const CH_COLORS: Record<string, string> = {
  "Organic Search": C.green,
  Direct: C.sand,
  "AI Assistant": "#7c5cbf",
  Social: C.blue,
  Referral: C.coral,
};
const chColor = (c: string) => CH_COLORS[c] ?? C.mid;

const STAGE_ORDER = ["New", "Qualified", "Viewing", "Listed", "Valuation", "Reserved", "Offer", "Deal"];
const STATUS_ORDER = ["Open", "Closed", "Completed"];

// Small "source not connected" card telling the user which env vars to add.
function ConnectCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="chart-card">
      <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
        <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>{title} not connected</div>
        <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.8 }}>
          Add to the deployment environment, then refresh:
          <br />
          {lines.map((l) => (
            <code key={l} style={{ display: "inline-block", margin: "2px 4px", background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>{l}</code>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SeoDashboard({ initial }: { initial: SeoData }) {
  const router = useRouter();
  const [data, setData] = useState<SeoData>(initial);
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [days, setDays] = useState<number>(30);
  const [from, setFrom] = useState<string>(ymd(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState<string>(ymd(new Date()));
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // keyword editor
  const [kwOpen, setKwOpen] = useState(false);
  const [kwInput, setKwInput] = useState(initial.keywords.join("\n"));
  const [kwMsg, setKwMsg] = useState<string | null>(null);
  const [kwSaving, startKwSave] = useTransition();

  const rangeQs = useCallback(() => {
    if (mode === "custom" && from && to && from <= to) return `from=${from}&to=${to}`;
    const t = new Date();
    const f = new Date(Date.now() - (days - 1) * 864e5);
    return `from=${ymd(f)}&to=${ymd(t)}`;
  }, [mode, from, to, days]);

  const load = useCallback(async (qs: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/seo?${qs}`, { cache: "no-store" });
      setData((await res.json()) as SeoData);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      /* keep last good data */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => setUpdatedAt(new Date().toLocaleTimeString()), []);

  function pickPreset(d: number) {
    setMode("preset");
    setDays(d);
    const t = new Date();
    const f = new Date(Date.now() - (d - 1) * 864e5);
    load(`from=${ymd(f)}&to=${ymd(t)}`);
  }
  function applyCustom() {
    if (from && to && from <= to) load(`from=${from}&to=${to}`);
  }
  function saveKeywords() {
    setKwMsg(null);
    const list = kwInput.split("\n").map((s) => s.trim()).filter(Boolean);
    startKwSave(async () => {
      const r = await saveSeoConfigAction(list);
      setKwMsg(r.ok ? "Saved — refreshing rankings…" : r.error);
      if (r.ok) {
        router.refresh();
        load(rangeQs());
      }
    });
  }

  const { traffic, gsc, leads } = data;
  const aiSources = traffic.aiBySource.slice(0, 8);
  const channels = traffic.byChannel.filter((c) => c.pageviews > 0);

  // pivot leads stage/status into {label -> {organic, ai}}
  const pivot = (rows: { segment: string; n: number }[] & any[], key: "stage" | "status") => {
    const m = new Map<string, { organic: number; ai: number }>();
    for (const r of rows) {
      const cur = m.get(r[key]) ?? { organic: 0, ai: 0 };
      if (r.segment === "organic") cur.organic = r.n;
      else if (r.segment === "ai") cur.ai = r.n;
      m.set(r[key], cur);
    }
    return m;
  };
  const stageMap = pivot(leads.stage as any, "stage");
  const statusMap = pivot(leads.status as any, "status");
  const orderRows = (m: Map<string, { organic: number; ai: number }>, order: string[]) => {
    const keys = [...new Set([...order, ...m.keys()])].filter((k) => m.has(k));
    return keys.map((k) => ({ label: k, ...(m.get(k) as { organic: number; ai: number }) }));
  };

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">SEO &amp; AIO</div>
          <div className="page-sub">Search &amp; AI performance — GSC · PostHog · Metabase · {data.label}</div>
        </div>
        <span className="bot-left" style={{ gap: 10, flexWrap: "wrap" }}>
          {(["GSC", "PostHog", "Metabase"] as const).map((s) => {
            const on = s === "GSC" ? gsc.connected : s === "PostHog" ? traffic.connected : leads.connected;
            return (
              <span key={s} style={{ fontSize: 11, color: on ? C.green : C.sand, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: on ? C.green : C.sand, display: "inline-block" }} />
                {s}
              </span>
            );
          })}
          {updatedAt && <span style={{ fontSize: 11, color: C.mid }}>· updated {updatedAt}</span>}
        </span>
      </div>

      {/* controls */}
      <div className="controls-bar">
        <div className="field">
          <label>Range <HelpTip text="Window for every metric. GSC data lags ~2–3 days, so the last couple of days may be partial." /></label>
          <div className="ps-platforms">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`filter-btn${mode === "preset" && days === d ? " active" : ""}`} onClick={() => pickPreset(d)}>{d}d</button>
            ))}
            <button className={`filter-btn${mode === "custom" ? " active" : ""}`} onClick={() => setMode("custom")}>Custom</button>
          </div>
        </div>
        {mode === "custom" && (
          <>
            <div className="field"><label>From</label><input type="date" className="ps-select" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="field"><label>To</label><input type="date" className="ps-select" value={to} min={from} max={ymd(new Date())} onChange={(e) => setTo(e.target.value)} /></div>
            <div className="field"><label>&nbsp;</label><button className="filter-btn" onClick={applyCustom} disabled={loading || !(from && to && from <= to)}>Apply</button></div>
          </>
        )}
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={() => load(rangeQs())} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
      </div>

      <div style={{ position: "relative", minHeight: 120 }}>
        {loading && <div className="seo-loading"><span className="spinner" />Updating…</div>}
        <div style={{ opacity: loading ? 0.4 : 1, transition: "opacity .15s", pointerEvents: loading ? "none" : "auto" }}>
          {/* KPI strip */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">AI referral leads <HelpTip text="Leads whose UTM/source is an LLM (ChatGPT, Perplexity…). From Metabase." /></div>
              <div className="kpi-value" style={{ color: C.green }}>{leads.connected ? fmt(leads.aiLeads) : "—"}</div>
              <div className="kpi-change">{leads.connected ? "Metabase · LLM sources" : "connect Metabase"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">AI sessions <HelpTip text="Website sessions referred by an LLM. From PostHog (humans only)." /></div>
              <div className="kpi-value">{fmt(traffic.aiSessions)}</div>
              <div className="kpi-change">PostHog · {aiSources[0]?.source ?? "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic clicks <HelpTip text="Google Search Console clicks for the range." /></div>
              <div className="kpi-value">{gsc.connected ? fmtK(gsc.totals?.clicks) : "—"}</div>
              <div className="kpi-change">{gsc.connected ? `GSC · CTR ${pct1(gsc.totals?.ctr)}` : "connect GSC"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic impressions <HelpTip text="Google Search Console impressions for the range." /></div>
              <div className="kpi-value">{gsc.connected ? fmtK(gsc.totals?.impressions) : "—"}</div>
              <div className="kpi-change">{gsc.connected ? `avg pos ${gsc.totals?.position ? gsc.totals.position.toFixed(1) : "—"}` : "connect GSC"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic pageviews <HelpTip text="Pageviews in sessions that arrived from a search engine. PostHog." /></div>
              <div className="kpi-value">{fmtK(traffic.organicPageviews)}</div>
              <div className="kpi-change">PostHog · search referrer</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Total pageviews</div>
              <div className="kpi-value">{fmtK(traffic.totalPageviews)}</div>
              <div className="kpi-change">PostHog · all channels (humans)</div>
            </div>
          </div>

          {/* traffic by channel + AI by source */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Traffic by channel</div>
              <div className="chart-sub">Pageviews by entry source · {traffic.label}</div>
              <div className="chart-canvas-wrap">
                {channels.length ? (
                  <ChartBox type="bar"
                    data={{ labels: channels.map((c) => c.channel), datasets: [{ label: "Pageviews", data: channels.map((c) => c.pageviews), backgroundColor: channels.map((c) => chColor(c.channel)), borderRadius: 5 }] }}
                    options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false, font: { size: 11 } } } } }} />
                ) : <div className="empty-state">{traffic.connected ? "No pageviews in range." : "PostHog not connected."}</div>}
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">AI sessions by source</div>
              <div className="chart-sub">LLM referrers · {traffic.aiSessions} AI sessions</div>
              <div className="chart-canvas-wrap">
                {aiSources.length ? (
                  <ChartBox type="bar"
                    data={{ labels: aiSources.map((s) => s.source), datasets: [{ label: "Sessions", data: aiSources.map((s) => s.sessions), backgroundColor: "#7c5cbf", borderRadius: 5 }] }}
                    options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { autoSkip: false, font: { size: 11 } } } } }} />
                ) : <div className="empty-state">No AI sessions in range.</div>}
              </div>
            </div>
          </div>

          {/* target keyword rankings */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Target keyword rankings <HelpTip text="Average Google position for each tracked keyword (lower = better). From GSC. Edit the list below." /></span>
              <button className="filter-btn" onClick={() => setKwOpen((v) => !v)}>{kwOpen ? "Done" : "Edit keywords"}</button>
            </div>
            <div className="chart-sub">GSC average position · {gsc.label} · {data.keywords.length} keywords</div>
            {kwOpen && (
              <div style={{ margin: "8px 0 14px" }}>
                <textarea className="search-box" style={{ width: "100%", minHeight: 140, fontFamily: "inherit", resize: "vertical" }}
                  value={kwInput} onChange={(e) => setKwInput(e.target.value)} placeholder="One keyword per line" />
                <div className="ps-save-row">
                  <button className="filter-btn" onClick={saveKeywords} disabled={kwSaving}>{kwSaving ? "Saving…" : "Save keywords"}</button>
                  {kwMsg && <span className="ps-save-msg">{kwMsg}</span>}
                </div>
              </div>
            )}
            {!gsc.connected ? (
              <ConnectCard title="Google Search Console" lines={["GSC_SITE_URL", "GSC_CLIENT_EMAIL", "GSC_PRIVATE_KEY"]} />
            ) : (
              <div className="table-scroll" style={{ marginTop: 6 }}>
                <table className="perf-table">
                  <thead><tr><th>Keyword</th><th>Avg position</th><th>Clicks</th><th>Impressions</th><th>CTR</th></tr></thead>
                  <tbody>
                    {[...gsc.keywords].sort((a, b) => (a.position ?? 999) - (b.position ?? 999)).map((k) => (
                      <tr key={k.keyword}>
                        <td>{k.keyword}</td>
                        <td className={k.position != null && k.position <= 10 ? "win" : ""}>{k.position != null ? k.position.toFixed(1) : "—"}</td>
                        <td>{fmt(k.clicks)}</td>
                        <td>{fmt(k.impressions)}</td>
                        <td>{pct1(k.ctr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* leads */}
          <div className="chart-title" style={{ marginTop: 22, marginBottom: 10 }}>Organic &amp; AI leads <HelpTip text="From the CRM via Metabase. Organic = website enquiries / pop-up with no paid UTM. AI = LLM UTM source." /></div>
          {!leads.connected ? (
            <ConnectCard title="Metabase" lines={["METABASE_URL", "METABASE_API_KEY"]} />
          ) : (
            <>
              <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
                <div className="kpi-card"><div className="kpi-label">AI referral leads</div><div className="kpi-value" style={{ color: C.green }}>{fmt(leads.aiLeads)}</div><div className="kpi-change">LLM UTM source</div></div>
                <div className="kpi-card"><div className="kpi-label">Organic leads</div><div className="kpi-value">{fmt(leads.organicLeads)}</div><div className="kpi-change">website + pop-up</div></div>
                <div className="kpi-card"><div className="kpi-label">Website · no UTM</div><div className="kpi-value">{fmt(leads.websiteNoUtm)}</div><div className="kpi-change">enquiries</div></div>
                <div className="kpi-card"><div className="kpi-label">Website pop-up</div><div className="kpi-value">{fmt(leads.popup)}</div><div className="kpi-change">pop-up leads</div></div>
              </div>

              <div className="charts-grid-2">
                <div className="chart-card">
                  <div className="chart-title">Lead pipeline — stage</div>
                  <div className="chart-sub">CRM stage · organic vs AI</div>
                  <div className="table-scroll">
                    <table className="perf-table">
                      <thead><tr><th>Stage</th><th>Organic</th><th>AI</th></tr></thead>
                      <tbody>
                        {orderRows(stageMap, STAGE_ORDER).map((r) => (
                          <tr key={r.label}><td>{r.label}</td><td>{fmt(r.organic)}</td><td>{fmt(r.ai)}</td></tr>
                        ))}
                        {stageMap.size === 0 && <tr><td colSpan={3} className="muted">No leads in range.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="chart-card">
                  <div className="chart-title">Open / closed status</div>
                  <div className="chart-sub">CRM state · organic vs AI</div>
                  <div className="table-scroll">
                    <table className="perf-table">
                      <thead><tr><th>Status</th><th>Organic</th><th>AI</th></tr></thead>
                      <tbody>
                        {orderRows(statusMap, STATUS_ORDER).map((r) => (
                          <tr key={r.label}><td>{r.label}</td><td>{fmt(r.organic)}</td><td>{fmt(r.ai)}</td></tr>
                        ))}
                        {statusMap.size === 0 && <tr><td colSpan={3} className="muted">No leads in range.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  {leads.aiBySource.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <div className="chart-sub" style={{ marginBottom: 6 }}>AI leads by source</div>
                      {leads.aiBySource.slice(0, 6).map((s) => (
                        <div key={s.source} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.mid, lineHeight: 1.9 }}>
                          <span>{s.source}</span><span style={{ fontWeight: 600, color: C.dark }}>{s.n}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          <div style={{ fontSize: 11, color: C.mid, marginTop: 14 }}>
            Sources: PostHog $pageview (humans, production hosts) · Google Search Console ({gsc.connected ? "live" : "not connected"}) · Metabase betterhomes leads ({leads.connected ? "live" : "not connected"}). Content production &amp; outreach are tracked outside these connectors and are intentionally omitted.
          </div>
        </div>
      </div>
    </>
  );
}
