"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker from "@/components/DateRangePicker";
import { saveSeoConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import type { SeoData } from "@/lib/seo";
import type { LeadsData } from "@/lib/metabase";
import { PAGE_SECTION_LABELS } from "@/lib/posthog";

const fmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n)));
const fmtK = (n: number | null | undefined) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
};
const pct1 = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

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

// One place to build the error state, so adding a field to LeadsData can't leave
// a stale object literal behind.
const emptyLeads = (error: string): LeadsData => ({
  connected: true, label: "", aiLeads: 0, organicLeads: 0, websiteNoUtm: 0, popup: 0,
  aiBySource: [], stage: [], status: [], sourceAudit: [], error,
});

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
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // Leads come from the slow Metabase view, but are committed together with the
  // PostHog/GSC half so the page never paints one range's traffic beside another
  // range's leads. See loadAll below.
  const [leads, setLeads] = useState<LeadsData | null>(null);
  const [leadsLoading, setLeadsLoading] = useState(true);

  // keyword editor
  const [kwOpen, setKwOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [kwInput, setKwInput] = useState(initial.keywords.join("\n"));
  const [kwMsg, setKwMsg] = useState<string | null>(null);
  const [kwSaving, startKwSave] = useTransition();

  const rangeQs = useCallback(() => `from=${from}&to=${to}`, [from, to]);

  // Pure fetchers — no state writes, so the caller controls when data appears.
  const fetchTraffic = useCallback(async (qs: string): Promise<SeoData | null> => {
    try {
      const res = await fetch(`/api/seo?${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && json.traffic) return json as SeoData;
      console.error("[seo] refresh returned an error", json?.error ?? res.status);
      return null;
    } catch (e) {
      console.error("[seo] refresh failed", e);
      return null;
    }
  }, []);

  const fetchLeads = useCallback(async (qs: string): Promise<LeadsData> => {
    try {
      const res = await fetch(`/api/seo/leads?${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && typeof json.connected === "boolean") return json as LeadsData;
      console.error("[seo] leads returned an error", json?.error ?? res.status);
      return emptyLeads(json?.error || `HTTP ${res.status}`);
    } catch (e) {
      console.error("[seo] leads fetch failed", e);
      return emptyLeads(String(e));
    }
  }, []);

  /**
   * Fetch the fast half (PostHog + GSC) and the slow half (the Metabase leads
   * view) concurrently, then commit both at once.
   *
   * They used to land independently, so a refresh repainted the traffic numbers
   * and left the lead numbers to arrive seconds later — the page filled in in
   * stages and looked, briefly, like it was reporting a different range for each
   * half. The sequence guard stops an older in-flight load from overwriting a
   * newer one when the range is changed twice quickly.
   */
  const seq = useRef(0);
  const loadAll = useCallback(
    async (qs: string) => {
      const mine = ++seq.current;
      setLoading(true);
      setLeadsLoading(true);
      // A fresh payload carries no audit rows, so collapse the table rather than
      // leaving it open and empty against the previous range.
      setAuditOpen(false);
      const [traffic, leadRows] = await Promise.all([fetchTraffic(qs), fetchLeads(qs)]);
      if (mine !== seq.current) return; // superseded
      if (traffic) {
        setData(traffic);
        setUpdatedAt(new Date().toLocaleTimeString());
      }
      setLeads(leadRows);
      setLeadsLoading(false);
      setLoading(false);
    },
    [fetchTraffic, fetchLeads],
  );

  /**
   * Buy / rent filter for the individual-property card. Rows come from PostHog
   * with the traffic payload, so switching is instant.
   */
  const [propFilter, setPropFilter] = useState<"all" | "buy" | "rent">("all");
  const propCounts = useMemo(() => {
    const rows = data.traffic.propertyViews ?? [];
    return {
      all: rows.length,
      buy: rows.filter((p) => p.kind === "buy").length,
      rent: rows.filter((p) => p.kind === "rent").length,
    };
  }, [data.traffic.propertyViews]);
  const activeProp = propFilter !== "all" && propCounts[propFilter] === 0 ? "all" : propFilter;
  const topProperties = useMemo(
    () => (data.traffic.propertyViews ?? []).filter((p) => activeProp === "all" || p.kind === activeProp).slice(0, 5),
    [data.traffic.propertyViews, activeProp],
  );

  // Landing-page section filter. Rows arrive with the traffic payload, so
  // switching sections is instant and costs no extra query.
  const [pageFilter, setPageFilter] = useState<string>("all");
  const pageSections = useMemo(() => {
    const acc = new Map<string, number>();
    for (const p of data.traffic.organicPages ?? []) acc.set(p.category, (acc.get(p.category) ?? 0) + p.views);
    // Only sections with views get a chip — an empty "New projects" filter is
    // just noise.
    return [...acc].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
  }, [data.traffic.organicPages]);
  // If the chosen section has nothing in the new range, fall back to All rather
  // than showing an empty table. Derived from the data instead of synced back
  // into state, so there's no cascading render.
  const activeSection = pageFilter !== "all" && !pageSections.some((s) => s.key === pageFilter) ? "all" : pageFilter;
  const topPages = useMemo(
    () => (data.traffic.organicPages ?? []).filter((p) => activeSection === "all" || p.category === activeSection).slice(0, 5),
    [data.traffic.organicPages, activeSection],
  );

  /**
   * The audit table costs a second full scan of the slow CRM view, so it's
   * fetched on first open rather than with every range change, and kept once
   * loaded.
   */
  const [auditLoading, setAuditLoading] = useState(false);
  const toggleAudit = useCallback(async () => {
    const opening = !auditOpen;
    setAuditOpen(opening);
    if (!opening || !leads || leads.sourceAudit.length > 0) return;
    setAuditLoading(true);
    try {
      const res = await fetch(`/api/seo/leads?${rangeQs()}&audit=1`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && Array.isArray(json?.sourceAudit)) {
        setLeads((prev) => (prev ? { ...prev, sourceAudit: json.sourceAudit } : prev));
      } else console.error("[seo] audit returned an error", json?.error ?? res.status);
    } catch (e) {
      console.error("[seo] audit fetch failed", e);
    } finally {
      setAuditLoading(false);
    }
  }, [auditOpen, leads, rangeQs]);

  // Leads are fetched on mount ON PURPOSE: the Metabase CRM view is slow enough
  // that server-rendering it stalls (and used to kill) the PostHog/GSC render, so
  // it stays a client-side load. That means flipping the loading flag during the
  // mount effect, which is the intended behaviour here, not a cascading render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll(rangeQs());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
    loadAll(`from=${f}&to=${t}`);
  }
  function refresh() {
    loadAll(rangeQs());
  }
  function saveKeywords() {
    setKwMsg(null);
    const list = kwInput.split("\n").map((s) => s.trim()).filter(Boolean);
    startKwSave(async () => {
      const r = await saveSeoConfigAction(list);
      setKwMsg(r.ok ? "Saved — refreshing rankings…" : r.error);
      if (r.ok) {
        router.refresh();
        loadAll(rangeQs());
      }
    });
  }

  const { traffic, gsc } = data;
  const aiSources = traffic.aiBySource.slice(0, 8);
  const channels = traffic.byChannel.filter((c) => c.pageviews > 0);
  const errors = [
    traffic.error ? `PostHog: ${traffic.error}` : null,
    gsc.connected && gsc.error ? `GSC: ${gsc.error}` : null,
    leads?.connected && leads.error ? `Metabase: ${leads.error}` : null,
  ].filter(Boolean) as string[];

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
  const stageMap = pivot((leads?.stage ?? []) as any, "stage");
  const statusMap = pivot((leads?.status ?? []) as any, "status");
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
          {([["GSC", gsc.connected], ["PostHog", traffic.connected], ["Metabase", leads ? leads.connected : null]] as [string, boolean | null][]).map(([s, on]) => (
            <span key={s} style={{ fontSize: 11, color: on == null ? C.sand : on ? C.green : C.sand, display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: on == null ? "#ccc" : on ? C.green : C.sand, display: "inline-block" }} />
              {s}
            </span>
          ))}
          {(updatedAt ?? (data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : null)) && (
            <span suppressHydrationWarning style={{ fontSize: 11, color: C.mid }}>
              · updated {updatedAt ?? new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          )}
        </span>
      </div>

      {/* controls */}
      <div className="controls-bar">
        <div className="field">
          <label>Range <HelpTip text="Window for every metric. GSC data lags ~2–3 days, so the last couple of days may be partial." /></label>
          <div className="ps-platforms">
            <DateRangePicker initialFrom={initial.from} initialTo={initial.to} onApply={applyRange} />
          </div>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={refresh} disabled={loading}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
      </div>

      <div style={{ position: "relative", minHeight: 120 }}>
        {loading && <div className="seo-loading"><span className="spinner" />Updating…</div>}
        <div style={{ opacity: loading ? 0.4 : 1, transition: "opacity .15s", pointerEvents: loading ? "none" : "auto" }}>
          {errors.length > 0 && (
            <div style={{ background: "rgba(201,74,74,.1)", border: "1px solid rgba(201,74,74,.35)", color: "var(--dark)", borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12.5, lineHeight: 1.7 }}>
              {errors.map((e, i) => (<div key={i}>⚠ {e}</div>))}
            </div>
          )}

          {/* KPI strip */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">AI referral leads <HelpTip text={`Leads whose UTM or enquiry source is an LLM (ChatGPT, Perplexity, Claude, Gemini…). Source: Metabase.${!leads ? " Still loading." : leads.connected ? "" : " Metabase is not connected."}`} /></div>
              <div className="kpi-value" style={{ color: C.green }}>{!leads ? "…" : leads.connected ? fmt(leads.aiLeads) : "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">AI sessions <HelpTip text={`Website sessions referred by an LLM. Top referrer in this range: ${aiSources[0]?.source ?? "none"}. Source: PostHog, bots excluded.`} /></div>
              <div className="kpi-value">{fmt(traffic.aiSessions)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic clicks <HelpTip text={gsc.connected ? `Google Search Console clicks for the range. Click-through rate ${pct1(gsc.totals?.ctr)}. Source: GSC.` : "Google Search Console clicks for the range. Source: GSC — not currently connected."} /></div>
              <div className="kpi-value">{gsc.connected ? fmtK(gsc.totals?.clicks) : "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic impressions <HelpTip text={gsc.connected ? `Google Search Console impressions for the range. Average position ${gsc.totals?.position ? gsc.totals.position.toFixed(1) : "—"} (lower is better). Source: GSC.` : "Google Search Console impressions for the range. Source: GSC — not currently connected."} /></div>
              <div className="kpi-value">{gsc.connected ? fmtK(gsc.totals?.impressions) : "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic pageviews <HelpTip text="Pageviews in sessions that arrived from a search engine. Source: PostHog, matched on the search referrer, bots excluded." /></div>
              <div className="kpi-value">{fmtK(traffic.organicPageviews)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Total pageviews <HelpTip text="Every pageview in the range, across all channels. Source: PostHog, bots excluded." /></div>
              <div className="kpi-value">{fmtK(traffic.totalPageviews)}</div>
            </div>
          </div>

          {/* traffic by channel + AI by source */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Traffic by channel</div>
              <div className="chart-sub">
                {traffic.approxChannels ? "Entry pageviews by source · approximate" : "Pageviews by entry source"} · {traffic.label}
              </div>
              <div className="chart-canvas-wrap">
                {channels.length ? (
                  <ChartBox type="bar"
                    data={{ labels: channels.map((c) => c.channel), datasets: [{ label: traffic.approxChannels ? "Entry pageviews" : "Pageviews", data: channels.map((c) => c.pageviews), backgroundColor: channels.map((c) => chColor(c.channel)), borderRadius: 5 }] }}
                    options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false, font: { size: 11 } } } } }} />
                ) : <div className="empty-state">{traffic.error ? `⚠ ${traffic.error}` : traffic.connected ? "No pageviews in range." : "PostHog not connected."}</div>}
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

          {/* Organic landing pages by views. PostHog, so it sits outside the
              Metabase block below — it must not disappear when the CRM is down. */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title">
              Top organic landing pages <HelpTip text="The pages search visitors arrived on, ranked by views, with unique visitors alongside. A pageview only carries a search-engine referrer on the entry hit, so these are landing pages by construction. From PostHog, bots excluded." />
            </div>
            <div className="chart-sub">
              Entry views from search · {activeSection === "all" ? "all sections" : PAGE_SECTION_LABELS[activeSection] ?? activeSection} · {traffic.label}
            </div>
            {pageSections.length > 1 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 4px" }}>
                <button className={`filter-btn${activeSection === "all" ? " active" : ""}`} onClick={() => setPageFilter("all")}>All</button>
                {pageSections.map((s) => (
                  <button key={s.key} className={`filter-btn${activeSection === s.key ? " active" : ""}`} onClick={() => setPageFilter(s.key)}>
                    {PAGE_SECTION_LABELS[s.key] ?? s.key} ({fmtK(s.n)})
                  </button>
                ))}
              </div>
            )}
            <div className="table-scroll">
              <table className="perf-table">
                <thead><tr><th>Page</th><th>Section</th><th style={{ textAlign: "right" }}>Visitors</th><th style={{ textAlign: "right" }}>Views</th></tr></thead>
                <tbody>
                  {topPages.map((p) => (
                    <tr key={p.path}>
                      <td><a href={`https://www.bhomes.com${p.path}`} target="_blank" rel="noopener noreferrer">{p.path}</a></td>
                      <td className="muted">{PAGE_SECTION_LABELS[p.category] ?? p.category}</td>
                      <td style={{ textAlign: "right" }}>{fmt(p.visitors)}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p.views)}</td>
                    </tr>
                  ))}
                  {topPages.length === 0 && (
                    <tr><td colSpan={4} className="muted">No organic entry pageviews in range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Most-viewed individual property pages. PostHog — the CRM stores no
              bhomes.com property URL at all, so page-level figures can only come
              from analytics. */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title">
              Top properties by views <HelpTip text="Individual property pages ranked by pageviews, with unique visitors alongside so repeat views are visible. From PostHog, bots excluded. Buy vs rent is read from the listing reference: bh-s- is for sale, bh-r- is to rent." />
            </div>
            <div className="chart-sub">
              Pageviews · {activeProp === "all" ? "buy and rent" : activeProp === "buy" ? "for sale" : "to rent"} · {traffic.label}
            </div>
            {propCounts.all > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 4px" }}>
                <button className={`filter-btn${activeProp === "all" ? " active" : ""}`} onClick={() => setPropFilter("all")}>All ({propCounts.all})</button>
                <button className={`filter-btn${activeProp === "buy" ? " active" : ""}`} onClick={() => setPropFilter("buy")}>Buy ({propCounts.buy})</button>
                <button className={`filter-btn${activeProp === "rent" ? " active" : ""}`} onClick={() => setPropFilter("rent")}>Rent ({propCounts.rent})</button>
              </div>
            )}
            <div className="table-scroll">
              <table className="perf-table">
                <thead><tr><th>Property</th><th>For</th><th style={{ textAlign: "right" }}>Visitors</th><th style={{ textAlign: "right" }}>Views</th></tr></thead>
                <tbody>
                  {topProperties.map((p) => (
                    <tr key={p.path}>
                      <td><a href={`https://www.bhomes.com${p.path}`} target="_blank" rel="noopener noreferrer">{p.slug}</a></td>
                      <td className="muted">{p.kind === "buy" ? "Sale" : p.kind === "rent" ? "Rent" : "—"}</td>
                      <td style={{ textAlign: "right" }}>{fmt(p.visitors)}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p.views)}</td>
                    </tr>
                  ))}
                  {topProperties.length === 0 && (
                    <tr><td colSpan={4} className="muted">No property pageviews in range.</td></tr>
                  )}
                </tbody>
              </table>
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
              <ConnectCard title="Google Search Console" lines={["SUPERMETRICS_API_KEY", "— or —", "GSC_CLIENT_EMAIL + GSC_PRIVATE_KEY"]} />
            ) : gsc.error ? (
              <div className="empty-state" style={{ height: "auto", padding: "22px 16px" }}>⚠ {gsc.error}</div>
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

          {/* leads (loaded separately) */}
          <div className="chart-title" style={{ marginTop: 22, marginBottom: 10 }}>Organic &amp; AI leads <HelpTip text="From the CRM via Metabase. Organic = website enquiries / pop-up with no paid UTM. AI = LLM UTM source. Loads separately so it never blocks the rest of the tab." /></div>
          {leadsLoading && !leads ? (
            <div className="chart-card"><div className="empty-state" style={{ height: 120 }}><span className="spinner" />Loading leads from Metabase…</div></div>
          ) : !leads?.connected ? (
            <ConnectCard title="Metabase" lines={["METABASE_URL", "METABASE_USERNAME", "METABASE_PASSWORD"]} />
          ) : leads.error ? (
            <div className="chart-card"><div className="empty-state" style={{ height: "auto", padding: "22px 16px" }}>⚠ {leads.error}</div></div>
          ) : (
            <>
              <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
                <div className="kpi-card"><div className="kpi-label">AI referral leads <HelpTip text="Leads whose UTM source is an LLM domain. Source: Metabase." /></div><div className="kpi-value" style={{ color: C.green }}>{fmt(leads.aiLeads)}</div></div>
                <div className="kpi-card"><div className="kpi-label">Organic leads <HelpTip text="Website enquiries with no UTM, plus pop-up leads. The pop-up figure is broken out on the Website tab. Source: Metabase." /></div><div className="kpi-value">{fmt(leads.organicLeads)}</div></div>
                <div className="kpi-card"><div className="kpi-label">Website · no UTM <HelpTip text="Website enquiries carrying no UTM source — the organic share on its own, excluding pop-up leads. Source: Metabase." /></div><div className="kpi-value">{fmt(leads.websiteNoUtm)}</div></div>
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

              {/* Audit trail. Organic and AI are inferred from free-text
                  enquiry_source and a JSON utm blob, so this shows every raw
                  combination and which bucket it landed in — the 'other' rows
                  are the ones worth reading, because that's where anything the
                  classifier doesn't recognise ends up. */}
              <div className="chart-card" style={{ marginTop: 4 }}>
                <div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>Lead source audit <HelpTip text="Every enquiry_source × utm combination in the CRM for this range, and the bucket it classifies into. Organic and AI are inferred from free text, so this is how you verify the classification is right — especially the 'other' rows." /></span>
                  <button className="filter-btn" onClick={toggleAudit} disabled={auditLoading}>{auditLoading ? "Loading…" : auditOpen ? "Hide" : "Show"}</button>
                </div>
                <div className="chart-sub">
                  {auditLoading
                    ? "Querying the CRM…"
                    : leads.sourceAudit.length
                      ? `${leads.sourceAudit.length} source combinations · ${leads.label}`
                      : "Loaded on demand — it costs an extra scan of the CRM view."}
                </div>
                {auditOpen && leads.sourceAudit.length > 0 && (
                  <div className="table-scroll" style={{ marginTop: 10, maxHeight: 420 }}>
                    <table className="perf-table">
                      <thead><tr><th>enquiry_source</th><th>utm.source</th><th>utm.medium</th><th>bucket</th><th style={{ textAlign: "right" }}>leads</th></tr></thead>
                      <tbody>
                        {leads.sourceAudit.map((r, i) => (
                          <tr key={i}>
                            <td>{r.enquirySource}</td>
                            <td className="muted">{r.utmSource}</td>
                            <td className="muted">{r.utmMedium}</td>
                            <td>
                              <span style={{ fontWeight: 600, color: r.segment === "ai" ? C.green : r.segment === "organic" ? C.dark : C.mid }}>
                                {r.segment}
                              </span>
                            </td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(r.n)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          <div style={{ fontSize: 11, color: C.mid, marginTop: 14 }}>
            Sources: PostHog $pageview (humans, production hosts) · Google Search Console ({gsc.connected ? "live" : "not connected"}) · Metabase betterhomes leads ({leads?.connected ? "live" : "not connected"}, loaded separately). Content production &amp; outreach are tracked outside these connectors and are intentionally omitted.
          </div>
        </div>
      </div>
    </>
  );
}
