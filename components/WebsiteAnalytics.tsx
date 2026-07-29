"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker from "@/components/DateRangePicker";
import Sankey from "@/components/Sankey";
import { receiveWebInsightsAction } from "@/app/actions";
import { C } from "@/lib/theme";
import type { WebMetrics } from "@/lib/posthog";

function insightColor(kind: string) {
  return kind === "high" ? C.red : kind === "medium" ? C.amber : C.green;
}

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));

const legendBottom = { legend: { position: "bottom" as const, labels: { font: { size: 10 } } } };

export default function WebsiteAnalytics({ initial }: { initial: WebMetrics }) {
  const [data, setData] = useState<WebMetrics>(initial);
  // Day-count of the current range, kept only because the insights action wants
  // a rough window size alongside the concrete dates.
  const [days, setDays] = useState<number>(initial.days || 30);
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [humansOnly, setHumansOnly] = useState<boolean>(initial.humansOnly ?? true);
  const [insights, setInsights] = useState<{ kind: string; label: string; text: string }[] | null>(null);
  const [insErr, setInsErr] = useState<string | null>(null);
  const [insPending, startInsights] = useTransition();
  const [flowInput, setFlowInput] = useState(""); // what's typed in the journey filter box
  const [flowPages, setFlowPages] = useState(""); // the applied journey filter
  const [flowExact, setFlowExact] = useState(false); // contains (false) vs exact (true) match

  const load = useCallback(async (qs: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/website?${qs}`, { cache: "no-store" });
      const json = (await res.json()) as WebMetrics;
      setData(json);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      /* keep last good data */
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // range query string (range only)
  const rangeQs = useCallback(() => `from=${from}&to=${to}`, [from, to]);
  // humans + journey-page-filter suffix shared by every load
  const tail = useCallback(
    (h = humansOnly) => `&humans=${h ? 1 : 0}${flowPages.trim() ? `&flowPages=${encodeURIComponent(flowPages.trim())}${flowExact ? "&flowMatch=exact" : ""}` : ""}`,
    [humansOnly, flowPages, flowExact],
  );
  const qsFor = useCallback(() => `${rangeQs()}${tail()}`, [rangeQs, tail]);

  // Silent auto-refresh every 60s while Live (no overlay flash).
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => load(qsFor(), true), 60_000);
    return () => clearInterval(id);
  }, [live, qsFor, load]);

  /**
   * Pop-up lead count, from the CRM. Fetched alongside the PostHog metrics and
   * committed with them rather than on its own: landing separately made the
   * page fill in in stages, with this number appearing seconds after the
   * traffic KPIs it sits beside.
   */
  const [popup, setPopup] = useState<number | null>(null);
  const [popupErr, setPopupErr] = useState(false);
  const fetchPopup = useCallback(async (f: string, t: string): Promise<{ n: number | null; err: boolean }> => {
    try {
      const res = await fetch(`/api/seo/leads?from=${f}&to=${t}`, { cache: "no-store" });
      const json = await res.json();
      const ok = res.ok && typeof json?.popup === "number" && !json.error;
      return { n: ok ? json.popup : null, err: !ok };
    } catch {
      return { n: null, err: true };
    }
  }, []);

  /**
   * Both sources for a range, committed together. The sequence guard stops an
   * older in-flight load from overwriting a newer one.
   */
  const seq = useRef(0);
  const loadAll = useCallback(
    async (f: string, t: string, suffix: string) => {
      const mine = ++seq.current;
      setLoading(true);
      const [, pop] = await Promise.all([load(`from=${f}&to=${t}${suffix}`, true), fetchPopup(f, t)]);
      if (mine !== seq.current) return;
      setPopup(pop.n);
      setPopupErr(pop.err);
      setLoading(false);
    },
    [load, fetchPopup],
  );

  // Both sources load on mount ON PURPOSE: the server renders PostHog metrics,
  // but the CRM pop-up figure is client-side, and it should appear with the rest
  // rather than after it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll(from, to, tail());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
    setDays(Math.max(1, Math.round((new Date(t).getTime() - new Date(f).getTime()) / 864e5) + 1));
    loadAll(f, t, tail());
  }
  function toggleHumans() {
    const next = !humansOnly;
    setHumansOnly(next);
    load(`${rangeQs()}${tail(next)}`, false);
  }
  function applyFlowFilter() {
    const pages = flowInput.trim();
    setFlowPages(pages);
    const t = `&humans=${humansOnly ? 1 : 0}${pages ? `&flowPages=${encodeURIComponent(pages)}${flowExact ? "&flowMatch=exact" : ""}` : ""}`;
    load(`${rangeQs()}${t}`, false);
  }
  // Switch contains/exact; re-run immediately if a filter is already applied.
  function setMatch(exact: boolean) {
    setFlowExact(exact);
    const pages = flowPages.trim();
    if (!pages) return;
    const t = `&humans=${humansOnly ? 1 : 0}&flowPages=${encodeURIComponent(pages)}${exact ? "&flowMatch=exact" : ""}`;
    load(`${rangeQs()}${t}`, false);
  }
  function clearFlowFilter() {
    setFlowInput("");
    setFlowPages("");
    load(`${rangeQs()}&humans=${humansOnly ? 1 : 0}`, false);
  }
  function getInsights() {
    setInsErr(null);
    startInsights(async () => {
      const r = await receiveWebInsightsAction(days, from, to);
      if (r.ok) setInsights(r.insights);
      else setInsErr(r.error);
    });
  }

  const ov = data.overview;
  const organicPct = ov && ov.sessions ? Math.round((ov.organic / ov.sessions) * 100) : null;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Website</div>
          <div className="page-sub">Live website traffic &amp; engagement — from PostHog · {data.label}</div>
        </div>
        <span className="bot-left" style={{ gap: 8 }}>
          {data.connected && <span className="pulse-dot" style={{ background: live ? C.green : C.sand }} />}
          <span style={{ fontSize: 12, color: C.mid }}>
            {data.connected ? (live ? "Live" : "Paused") : "Not connected"}
            {(updatedAt ?? (data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : null)) ? (
              <span suppressHydrationWarning> · updated {updatedAt ?? new Date(data.generatedAt).toLocaleTimeString()}</span>
            ) : null}
          </span>
        </span>
      </div>

      {/* controls */}
      <div className="controls-bar">
        <div className="field">
          <label>Range <HelpTip text="Time window for every metric on this page." /></label>
          <div className="ps-platforms">
            <DateRangePicker initialFrom={initial.from} initialTo={initial.to} onApply={applyRange} />
          </div>
        </div>

        <div className="field">
          <label>Traffic <HelpTip text="Humans only excludes bots/crawlers — PostHog-flagged bots, traffic from cloud datacenters (e.g. AWS Ashburn), and desktop-Linux/server traffic (the China/Singapore/Hong Kong server bots). Switch to All traffic to see the raw, bot-inflated numbers." /></label>
          <button className={`filter-btn${humansOnly ? " active" : ""}`} onClick={toggleHumans}>
            {humansOnly ? "🧍 Humans only" : "All traffic"}
          </button>
        </div>
        <div className="field">
          <label>Auto-refresh <HelpTip text="When on, re-queries PostHog every 60 seconds so the numbers stay live (no spinner flash)." /></label>
          <button className={`filter-btn${live ? " active" : ""}`} onClick={() => setLive((v) => !v)}>
            {live ? "● Live (60s)" : "Paused"}
          </button>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={() => load(qsFor(), false)} disabled={loading}>
            {loading ? "Refreshing…" : "↻ Refresh now"}
          </button>
        </div>
      </div>

      {/* results (with loading overlay) */}
      <div style={{ position: "relative", minHeight: 120 }}>
        {loading && (
          <div className="seo-loading">
            <span className="spinner" />Updating…
          </div>
        )}
        <div style={{ opacity: loading ? 0.4 : 1, transition: "opacity .15s", pointerEvents: loading ? "none" : "auto" }}>
          {!data.connected ? (
            <div className="chart-card">
              <div className="empty-state" style={{ height: 150 }}>
                PostHog isn&apos;t connected yet.<br />
                Add <strong>POSTHOG_API_KEY</strong> (a personal API key with Query:Read) to the Vercel environment, then redeploy.
              </div>
            </div>
          ) : !data.hasData ? (
            <div className="chart-card">
              <div className="empty-state" style={{ height: 150 }}>
                Connected to PostHog, but no <code>$pageview</code> events were found in {data.label}.<br />
                Make sure PostHog web tracking (posthog-js) is installed on the website, or widen the range.
              </div>
            </div>
          ) : (
            <>
              {data.bots.pageviews > 0 && (
                <div className="seo-bot-banner">
                  <span>
                    🤖 <strong>{fmt(data.bots.pageviews)}</strong> automated / bot pageviews detected — <strong>{data.bots.pct}%</strong> of all traffic
                    (headless crawlers + cloud-datacenter &amp; Linux/server traffic — e.g. AWS Ashburn, plus China / Singapore / Hong Kong servers).{" "}
                    {humansOnly ? "Excluded from the figures below." : "Currently included in the figures below."}
                  </span>
                  <button className="filter-btn" onClick={toggleHumans}>
                    {humansOnly ? "Show all traffic" : "Hide bots"}
                  </button>
                </div>
              )}

              {/* KPIs */}
              <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
                <div className="kpi-card">
                  <div className="kpi-label">Unique visitors</div>
                  <div className="kpi-value">{fmt(ov!.visitors)}</div>
                  <div className="kpi-change">{data.label}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Pageviews</div>
                  <div className="kpi-value">{fmt(ov!.pageviews)}</div>
                  <div className="kpi-change">{ov!.visitors ? `${(ov!.pageviews / ov!.visitors).toFixed(1)} per visitor` : ""}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Sessions</div>
                  <div className="kpi-value">{fmt(ov!.sessions)}</div>
                  <div className="kpi-change">visits</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Organic search <HelpTip text="Sessions that arrived from a search engine (Google, Bing, etc.) — your SEO-driven traffic." /></div>
                  <div className="kpi-value" style={{ color: C.green }}>{fmt(ov!.organic)}</div>
                  <div className="kpi-change up">{organicPct != null ? `${organicPct}% of sessions` : ""}</div>
                </div>
              </div>

              {/* Pop-up leads come from the CRM, not PostHog, so this is fetched
                  separately — a slow or failing CRM query must not hold up or
                  blank out the traffic KPIs above. */}
              <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
                <div className="kpi-card">
                  <div className="kpi-label">Website pop-up leads <HelpTip text="Leads captured by the on-site pop-up, counted in the CRM for this date range. Sourced from Metabase, not PostHog." /></div>
                  <div className="kpi-value">{popupErr ? "—" : popup == null ? "…" : fmt(popup)}</div>
                  <div className="kpi-change">{popupErr ? "CRM unavailable" : popup == null ? "loading from CRM" : "pop-up enquiries"}</div>
                </div>
              </div>

              {/* trend + sources */}
              <div className="charts-grid-2">
                <div className="chart-card">
                  <div className="chart-title">Traffic over time</div>
                  <div className="chart-sub">Pageviews (bars) &amp; unique visitors (line) per day</div>
                  <div className="chart-canvas-wrap">
                    <ChartBox
                      type="bar"
                      data={{
                        labels: data.trend.map((t) => t.day.slice(5)),
                        datasets: [
                          { type: "bar", label: "Pageviews", data: data.trend.map((t) => t.pageviews), backgroundColor: C.coral + "99", yAxisID: "y" },
                          { type: "line", label: "Visitors", data: data.trend.map((t) => t.visitors), borderColor: C.dark, backgroundColor: "transparent", yAxisID: "y", tension: 0.3, pointRadius: 2 },
                        ],
                      }}
                      options={{ plugins: legendBottom, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
                    />
                  </div>
                </div>

                <div className="chart-card">
                  <div className="chart-title">Top traffic sources</div>
                  <div className="chart-sub">Sessions by referring domain</div>
                  <div className="chart-canvas-wrap">
                    <ChartBox
                      type="bar"
                      data={{
                        labels: data.sources.map((s) => s.source),
                        datasets: [{ label: "Sessions", data: data.sources.map((s) => s.sessions), backgroundColor: C.sage }],
                      }}
                      options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { autoSkip: false, font: { size: 10 } } } } }}
                    />
                  </div>
                </div>
              </div>

              {/* pages + countries */}
              <div className="charts-grid-2">
                <div className="chart-card">
                  <div className="chart-title">Top pages</div>
                  <div className="chart-sub">Most-viewed pages in range</div>
                  <div className="chart-canvas-wrap">
                    <ChartBox
                      type="bar"
                      data={{
                        labels: data.topPages.map((p) => p.path),
                        datasets: [{ label: "Pageviews", data: data.topPages.map((p) => p.views), backgroundColor: C.coral }],
                      }}
                      options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { autoSkip: false, font: { size: 10 } } } } }}
                    />
                  </div>
                </div>

                <div className="chart-card">
                  <div className="chart-title">Visitors by country</div>
                  <div className="chart-sub">Where your audience is</div>
                  <div className="chart-canvas-wrap">
                    <ChartBox
                      type="bar"
                      data={{
                        labels: data.countries.map((c) => c.country),
                        datasets: [{ label: "Visitors", data: data.countries.map((c) => c.visitors), backgroundColor: C.blue }],
                      }}
                      options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { ticks: { autoSkip: false, font: { size: 10 } } } } }}
                    />
                  </div>
                </div>
              </div>

              {/* user-journey Sankey — first 3 page touchpoints */}
              <div className="chart-card" style={{ marginTop: 16 }}>
                <div className="chart-title">
                  User journeys — source + first 3 pages
                  <HelpTip text="How real visitors move: entry Source → 1st page → 2nd page → 3rd page. URLs are grouped into page types (Buy listings, Blog, Area guides…); only the top 5 show, rest as 'Other'. Ribbon thickness = sessions. Where a node's ribbons thin out, that gap is drop-off — those visitors left." />
                </div>
                <div className="chart-sub">
                  Source → 1st → 2nd → 3rd page · top 5 page types · drop-off implied · {fmt(data.flow.sessions)} human sessions (visits — not unique visitors; a returning visitor counts once per visit){flowPages ? ` · filtered to: ${flowPages} (${flowExact ? "exact" : "contains"})` : ""}
                </div>
                <div className="table-controls" style={{ marginTop: 8, marginBottom: 4 }}>
                  <input
                    className="search-box"
                    placeholder="Focus on page(s) — keyword, path, or full URL; separate multiple with commas"
                    value={flowInput}
                    onChange={(e) => setFlowInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") applyFlowFilter(); }}
                  />
                  <div className="ps-platforms" title="Contains = page path includes the text. Exact = the page equals it exactly.">
                    <button className={`filter-btn${!flowExact ? " active" : ""}`} onClick={() => setMatch(false)} disabled={loading}>Contains</button>
                    <button className={`filter-btn${flowExact ? " active" : ""}`} onClick={() => setMatch(true)} disabled={loading}>Exact</button>
                  </div>
                  <button className="filter-btn" onClick={applyFlowFilter} disabled={loading}>Apply</button>
                  {flowPages && <button className="filter-btn" onClick={clearFlowFilter} disabled={loading}>Clear</button>}
                  <HelpTip text="Filter the journeys to sessions that pass through the page(s) you enter. Separate multiple pages with commas (any match is kept). Contains = path includes the text (e.g. 'buy'); Exact = the page equals it exactly — paste a full URL from a node's breakdown for an exact match." />
                </div>
                {data.flow.nodes.length > 0 ? (
                  <Sankey flow={data.flow} captions={["Source", "1st page", "2nd page", "3rd page"]} />
                ) : (
                  <div className="empty-state" style={{ height: 120 }}>
                    No journeys{flowPages ? ` involving “${flowPages}”` : ""} in this range.
                  </div>
                )}
              </div>

              <div style={{ fontSize: 11, color: C.mid, marginTop: 12 }}>
                Source: PostHog <code>$pageview</code> events · organic = sessions from search engines.
              </div>

              {/* AI data-driven insights */}
              <div className="insights-panel" style={{ marginTop: 20 }}>
                <div className="insights-head">
                  <div>
                    <div className="insights-title">Data-driven insights</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 4 }}>
                      AI recommendations from your real (bot-filtered) traffic — {data.label}
                    </div>
                  </div>
                  <button className="filter-btn" onClick={getInsights} disabled={insPending}>
                    {insPending ? "Analysing…" : insights ? "↻ Refresh" : "Receive insights"}
                  </button>
                </div>
                {insErr && <div className="insights-err">{insErr}</div>}
                {!insights && !insErr && !insPending && (
                  <div style={{ color: "rgba(255,255,255,.45)", fontSize: 13, padding: "12px 0 4px" }}>
                    Click &ldquo;Receive insights&rdquo; for AI recommendations based on the traffic, pages, sources and journeys above.
                  </div>
                )}
                {insPending && (
                  <div style={{ color: "rgba(255,255,255,.55)", fontSize: 13, padding: "12px 0 4px" }}>Asking Gemini to analyse {data.label}…</div>
                )}
                {insights && (
                  <div className="insights-grid">
                    {insights.map((ins, i) => (
                      <div key={i} className="insight-card" style={{ borderLeftColor: insightColor(ins.kind) }}>
                        <div className="i-type">{ins.label}</div>
                        <div className="i-text">{ins.text}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
