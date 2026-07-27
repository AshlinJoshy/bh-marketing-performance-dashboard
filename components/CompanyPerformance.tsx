"use client";

// Company Performance — a live rebuild of the "Leads & deals by channel" report,
// reading the Engage CRM through Metabase instead of a static export.
//
// Only the BRAND filter refetches: it changes the SQL. Period, division, group-by
// and channel all slice the payload client-side, so they're instant.
//
// Portal economics (spend, cost per deal, revenue after portal expense, return on
// spend) are intentionally absent — the CRM holds no spend data.
import { useCallback, useEffect, useMemo, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { C } from "@/lib/theme";
import type { CompanyData, DealDivision, LeadDivision } from "@/lib/company";

/* ── formatting (mirrors the report's fmt* helpers) ───────────────────────── */
const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const fmtCompact = (n: number) => {
  const v = n || 0;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return fmtInt(v);
};
const fmtAED = (n: number) => `AED ${fmtCompact(n)}`;
const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);

const START_LABEL = "January 2025";

const CH_COLOR: Record<string, string> = {
  "Property Finder": C.dark,
  Bayut: C.coral,
  "Client Referral": C.sage,
  "Previous Tenant/Buyer": C.blue,
  "Meta/Facebook": "#7c5cbf",
  "Agent External": C.amber,
  Dubizzle: C.green,
  "No Source": C.sand,
  Other: C.mid,
};

type DivKey = "All" | "Sales" | "Offplan" | "Secondary" | "Leasing";
const DIV_LABEL: Record<DivKey, string> = {
  All: "All",
  Sales: "Sales",
  Offplan: "Off-plan",
  Secondary: "Secondary",
  Leasing: "Leasing",
};

/**
 * Which stored divisions a filter selects. Leads are stored Sales/Leasing while
 * deals are stored Offplan/Secondary/Leasing, so off-plan and secondary have no
 * lead series at all — enquiries carry no off-plan flag. Conversion is therefore
 * only meaningful for All, Sales and Leasing.
 */
function divsFor(d: DivKey): { leadDivs: LeadDivision[]; dealDivs: DealDivision[]; convValid: boolean } {
  switch (d) {
    case "Sales":
      return { leadDivs: ["Sales"], dealDivs: ["Offplan", "Secondary"], convValid: true };
    case "Offplan":
      return { leadDivs: [], dealDivs: ["Offplan"], convValid: false };
    case "Secondary":
      return { leadDivs: [], dealDivs: ["Secondary"], convValid: false };
    case "Leasing":
      return { leadDivs: ["Leasing"], dealDivs: ["Leasing"], convValid: true };
    default:
      return { leadDivs: ["Sales", "Leasing"], dealDivs: ["Offplan", "Secondary", "Leasing"], convValid: true };
  }
}

type GroupBy = "month" | "quarter" | "year";
const bucketOf = (month: string, g: GroupBy) => {
  const [y, m] = month.split("-");
  if (g === "year") return y;
  if (g === "quarter") return `${y} Q${Math.floor((Number(m) - 1) / 3) + 1}`;
  return month;
};
const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyMonth = (m: string) => `${MONTH_LABEL[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const prettyBucket = (b: string, g: GroupBy) => (g === "month" ? prettyMonth(b) : b);

export default function CompanyPerformance({ initial }: { initial: CompanyData }) {
  const [data, setData] = useState<CompanyData>(initial);
  const [loading, setLoading] = useState(false);
  const [brandIds, setBrandIds] = useState<number[]>([]);

  const [period, setPeriod] = useState<string>("all"); // all | 2025 | 2026
  const [division, setDivision] = useState<DivKey>("All");
  const [groupBy, setGroupBy] = useState<GroupBy>("month");
  const [channel, setChannel] = useState<string>("all");
  const [revShare, setRevShare] = useState(false);
  const [contribMetric, setContribMetric] = useState<"leads" | "deals" | "revenue">("revenue");

  /* ── brand filter is the only server round trip ─────────────────────────── */
  const load = useCallback(async (ids: number[]) => {
    setLoading(true);
    try {
      const qs = ids.length ? `?brands=${ids.join(",")}` : "";
      const res = await fetch(`/api/company${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.months)) setData(json as CompanyData);
      else console.error("[company] refresh returned an error", json?.error ?? res.status);
    } catch (e) {
      console.error("[company] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const firstRun = useMemo(() => ({ done: false }), []);
  useEffect(() => {
    if (!firstRun.done) {
      firstRun.done = true;
      return; // the server already rendered the unfiltered view
    }
    load(brandIds);
  }, [brandIds, load, firstRun]);

  const { months, channels } = data;
  const { leadDivs, dealDivs, convValid } = divsFor(division);

  /* ── month indices for the selected period, and the comparable previous one ─ */
  const { idxs, prevIdxs, periodLabel } = useMemo(() => {
    let sel = months.map((_, i) => i);
    if (period === "2025") sel = months.map((m, i) => (m.startsWith("2025") ? i : -1)).filter((i) => i >= 0);
    else if (period === "2026") sel = months.map((m, i) => (m.startsWith("2026") ? i : -1)).filter((i) => i >= 0);
    const first = sel[0] ?? 0;
    const prev = [];
    for (let i = Math.max(0, first - sel.length); i < first; i++) prev.push(i);
    const lbl =
      period === "all"
        ? `${prettyMonth(months[0] ?? "")} – ${prettyMonth(months[months.length - 1] ?? "")}`
        : period === "2025"
          ? "2025"
          : "2026 to date";
    return { idxs: sel, prevIdxs: prev, periodLabel: lbl };
  }, [months, period]);

  const activeChannels = channel === "all" ? channels : channels.filter((c) => c === channel);

  /* ── aggregation helpers ────────────────────────────────────────────────── */
  const sumOver = useCallback(
    (block: Record<string, Record<string, number[]>>, divs: string[], chs: string[], indices: number[]) => {
      let t = 0;
      for (const dv of divs) for (const c of chs) for (const i of indices) t += block[dv]?.[c]?.[i] ?? 0;
      return t;
    },
    [],
  );

  const byChannel = useCallback(
    (block: Record<string, Record<string, number[]>>, divs: string[], indices: number[]) => {
      const out: Record<string, number> = {};
      for (const c of channels) {
        let t = 0;
        for (const dv of divs) for (const i of indices) t += block[dv]?.[c]?.[i] ?? 0;
        out[c] = t;
      }
      return out;
    },
    [channels],
  );

  const totals = useMemo(() => {
    const leads = sumOver(data.leads, leadDivs, activeChannels, idxs);
    const deals = sumOver(data.deals, dealDivs, activeChannels, idxs);
    const revenue = sumOver(data.comm, dealDivs, activeChannels, idxs);
    const pLeads = sumOver(data.leads, leadDivs, activeChannels, prevIdxs);
    const pDeals = sumOver(data.deals, dealDivs, activeChannels, prevIdxs);
    const pRevenue = sumOver(data.comm, dealDivs, activeChannels, prevIdxs);
    // all sales deals, for the off-plan / secondary share KPI
    const allSales = sumOver(data.deals, ["Offplan", "Secondary"], activeChannels, idxs);
    return { leads, deals, revenue, pLeads, pDeals, pRevenue, allSales };
  }, [data, leadDivs, dealDivs, activeChannels, idxs, prevIdxs, sumOver]);

  const delta = (now: number, before: number): string | null => {
    if (!before || !Number.isFinite(before)) return null;
    const d = (now - before) / before;
    return `${d >= 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(1)}% vs prev`;
  };

  /* ── per-bucket series for the stacked charts ───────────────────────────── */
  const buckets = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, number[]>();
    for (const i of idxs) {
      const b = bucketOf(months[i], groupBy);
      if (!map.has(b)) {
        map.set(b, []);
        order.push(b);
      }
      map.get(b)!.push(i);
    }
    return { order, map };
  }, [idxs, months, groupBy]);

  const stack = useCallback(
    (block: Record<string, Record<string, number[]>>, divs: string[]) =>
      activeChannels.map((c) => ({
        label: c,
        data: buckets.order.map((b) => {
          let t = 0;
          for (const dv of divs) for (const i of buckets.map.get(b)!) t += block[dv]?.[c]?.[i] ?? 0;
          return t;
        }),
        backgroundColor: CH_COLOR[c] ?? C.mid,
        borderWidth: 0,
      })),
    [activeChannels, buckets],
  );

  const stackedOpts = (money = false, pct = false) => ({
    responsive: true,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { position: "bottom" as const, labels: { boxWidth: 10, font: { size: 10 }, padding: 10 } },
      tooltip: {
        callbacks: {
          label: (ctx: any) =>
            `${ctx.dataset.label}: ${pct ? `${Number(ctx.raw).toFixed(1)}%` : money ? fmtAED(Number(ctx.raw)) : fmtInt(Number(ctx.raw))}`,
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
      y: {
        stacked: true,
        beginAtZero: true,
        max: pct ? 100 : undefined,
        grid: { color: C.border },
        ticks: { font: { size: 10 }, callback: (v: any) => (pct ? `${v}%` : money ? fmtCompact(Number(v)) : fmtCompact(Number(v))) },
      },
    },
  });

  const toPercent = (datasets: any[]) => {
    const n = datasets[0]?.data.length ?? 0;
    const tot = new Array(n).fill(0);
    for (const ds of datasets) ds.data.forEach((v: number, i: number) => (tot[i] += v));
    return datasets.map((ds) => ({ ...ds, data: ds.data.map((v: number, i: number) => (tot[i] ? (v / tot[i]) * 100 : 0)) }));
  };

  const revDatasets = useMemo(() => {
    const ds = stack(data.comm, dealDivs);
    return revShare ? toPercent(ds) : ds;
  }, [stack, data.comm, dealDivs, revShare]);

  const leadDatasets = useMemo(() => stack(data.leads, leadDivs), [stack, data.leads, leadDivs]);
  const dealDatasets = useMemo(() => stack(data.deals, dealDivs), [stack, data.deals, dealDivs]);

  /* ── channel summary ───────────────────────────────────────────────────── */
  const summary = useMemo(() => {
    const L = byChannel(data.leads, leadDivs, idxs);
    const D = byChannel(data.deals, dealDivs, idxs);
    const R = byChannel(data.comm, dealDivs, idxs);
    const tL = Object.values(L).reduce((a, b) => a + b, 0);
    const tD = Object.values(D).reduce((a, b) => a + b, 0);
    const tR = Object.values(R).reduce((a, b) => a + b, 0);
    return channels
      .map((c) => {
        // "No Source" deals include those with no linked lead at all, so a
        // conversion rate for that row isn't meaningful.
        const conv = convValid && c !== "No Source" && L[c] > 0 ? D[c] / L[c] : null;
        return {
          channel: c,
          leads: L[c],
          deals: D[c],
          conv,
          revenue: R[c],
          revPct: tR ? R[c] / tR : 0,
          avgComm: D[c] ? R[c] / D[c] : 0,
          leadPct: tL ? L[c] / tL : 0,
          dealPct: tD ? D[c] / tD : 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }, [data, channels, leadDivs, dealDivs, idxs, byChannel, convValid]);

  const convRows = useMemo(
    () => summary.filter((r) => r.conv != null).sort((a, b) => (b.conv ?? 0) - (a.conv ?? 0)),
    [summary],
  );

  const contribDatasets = useMemo(() => {
    const block = contribMetric === "leads" ? data.leads : contribMetric === "deals" ? data.deals : data.comm;
    const divs = contribMetric === "leads" ? leadDivs : dealDivs;
    return toPercent(stack(block, divs));
  }, [contribMetric, data, leadDivs, dealDivs, stack]);

  /* ── full data table + CSV (always the whole dataset, ignoring filters) ─── */
  const fullRows = useMemo(() => {
    const rows: { month: string; channel: string; division: string; leads: number | ""; deals: number; revenue: number }[] = [];
    for (let i = 0; i < months.length; i++) {
      for (const c of channels) {
        for (const dv of ["Offplan", "Secondary", "Leasing"] as DealDivision[]) {
          const deals = data.deals[dv]?.[c]?.[i] ?? 0;
          const revenue = data.comm[dv]?.[c]?.[i] ?? 0;
          // leads only exist as Sales / Leasing
          const leadDv: LeadDivision | null = dv === "Leasing" ? "Leasing" : null;
          const leads = leadDv ? (data.leads[leadDv]?.[c]?.[i] ?? 0) : "";
          if (!deals && !revenue && leads === "") continue;
          rows.push({ month: months[i], channel: c, division: DIV_LABEL[dv], leads, deals, revenue });
        }
      }
      // sales-side leads have no off-plan/secondary split, so they get their own row
      for (const c of channels) {
        const leads = data.leads.Sales?.[c]?.[i] ?? 0;
        if (leads) rows.push({ month: months[i], channel: c, division: "Sales (leads only)", leads, deals: 0, revenue: 0 });
      }
    }
    return rows;
  }, [months, channels, data]);

  const downloadCsv = () => {
    const head = ["Month", "Channel", "Division", "Leads", "Deals", "Gross commission (AED)"];
    const body = fullRows.map((r) => [r.month, r.channel, r.division, r.leads === "" ? "" : r.leads, r.deals, Math.round(r.revenue)]);
    const csv = [head, ...body].map((r) => r.map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v)).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `company-performance-${data.from}-to-${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const salesDivision = division === "Offplan" || division === "Secondary";
  const notConnected = !data.connected;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Company Performance</div>
          <div className="page-sub">
            Leads, deals and revenue by channel · {periodLabel} · live from the Engage CRM
            {loading ? " · updating…" : ""}
          </div>
        </div>
      </div>

      {notConnected ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>Metabase not connected</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.8 }}>
              Add to the deployment environment, then refresh:
              <br />
              {["METABASE_URL", "METABASE_USERNAME", "METABASE_PASSWORD"].map((l) => (
                <code key={l} style={{ display: "inline-block", margin: "2px 4px", background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>
                  {l}
                </code>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {data.error ? (
            <div className="chart-card" style={{ marginBottom: 18, borderColor: C.amber }}>
              <div style={{ fontSize: 12, color: C.amber, fontWeight: 600 }}>Partial data</div>
              <div style={{ fontSize: 12, color: C.mid, marginTop: 4 }}>{data.error}</div>
            </div>
          ) : null}

          {/* ── controls ──────────────────────────────────────────────────── */}
          <div className="controls-bar">
            <div className="field">
              <label>Period <HelpTip text="Jan 2025 onwards. Deltas compare against the immediately preceding window of equal length." /></label>
              <div className="ps-platforms">
                {[
                  ["all", "All"],
                  ["2025", "2025"],
                  ["2026", "2026 YTD"],
                ].map(([v, l]) => (
                  <button key={v} className={`filter-btn${period === v ? " active" : ""}`} onClick={() => setPeriod(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Division <HelpTip text="Deals split Sale vs Rent as recorded in the CRM. A sale is off-plan when its linked property is flagged “Off Plan”. Enquiries carry no off-plan flag, so lead counts and conversion aren't available for off-plan or secondary on their own." /></label>
              <div className="ps-platforms">
                {(["All", "Sales", "Offplan", "Secondary", "Leasing"] as DivKey[]).map((d) => (
                  <button key={d} className={`filter-btn${division === d ? " active" : ""}`} onClick={() => setDivision(d)}>
                    {DIV_LABEL[d]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Group by</label>
              <div className="ps-platforms">
                {(["month", "quarter", "year"] as GroupBy[]).map((g) => (
                  <button key={g} className={`filter-btn${groupBy === g ? " active" : ""}`} onClick={() => setGroupBy(g)}>
                    {g[0].toUpperCase() + g.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Brand <HelpTip text="The trading entity that booked the deal. Refetches from the CRM." /></label>
              <select
                className="ps-select"
                value={brandIds.length === 1 ? String(brandIds[0]) : "all"}
                onChange={(e) => setBrandIds(e.target.value === "all" ? [] : [Number(e.target.value)])}
                disabled={loading}
              >
                <option value="all">All brands</option>
                {data.brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Channel</label>
              <select className="ps-select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="all">All channels</option>
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* ── KPIs ──────────────────────────────────────────────────────── */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
            {salesDivision ? (
              <>
                <div className="kpi-card">
                  <div className="kpi-label">Deals</div>
                  <div className="kpi-value">{fmtInt(totals.deals)}</div>
                  <div className="kpi-change">{delta(totals.deals, totals.pDeals) ?? DIV_LABEL[division]}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Share of sales deals <HelpTip text="This division's deals as a share of all Sale deals (off-plan + secondary)." /></div>
                  <div className="kpi-value">{fmtPct(totals.allSales ? totals.deals / totals.allSales : null)}</div>
                  <div className="kpi-change">of {fmtInt(totals.allSales)} sales deals</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Revenue</div>
                  <div className="kpi-value" style={{ color: C.green }}>{fmtAED(totals.revenue)}</div>
                  <div className="kpi-change">{delta(totals.revenue, totals.pRevenue) ?? "gross commission"}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Avg commission per deal</div>
                  <div className="kpi-value">{fmtAED(totals.deals ? totals.revenue / totals.deals : 0)}</div>
                  <div className="kpi-change">per closed deal</div>
                </div>
              </>
            ) : (
              <>
                <div className="kpi-card">
                  <div className="kpi-label">Leads</div>
                  <div className="kpi-value">{fmtInt(totals.leads)}</div>
                  <div className="kpi-change">{delta(totals.leads, totals.pLeads) ?? "enquiries"}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Deals</div>
                  <div className="kpi-value">{fmtInt(totals.deals)}</div>
                  <div className="kpi-change">{delta(totals.deals, totals.pDeals) ?? "reservations + completions"}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Revenue <HelpTip text="Final gross commission in AED." /></div>
                  <div className="kpi-value" style={{ color: C.green }}>{fmtAED(totals.revenue)}</div>
                  <div className="kpi-change">{delta(totals.revenue, totals.pRevenue) ?? "gross commission"}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Conversion <HelpTip text="Deals ÷ leads for the selected division and period." /></div>
                  <div className="kpi-value">{fmtPct(convValid && totals.leads ? totals.deals / totals.leads : null, 2)}</div>
                  <div className="kpi-change">
                    {fmtAED(totals.deals ? totals.revenue / totals.deals : 0)} per deal
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── revenue contribution ──────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Revenue contribution by channel</div>
                <div className="chart-sub">Gross commission, AED · {groupBy}ly</div>
              </div>
              <div className="ps-platforms">
                <button className={`filter-btn${!revShare ? " active" : ""}`} onClick={() => setRevShare(false)}>AED</button>
                <button className={`filter-btn${revShare ? " active" : ""}`} onClick={() => setRevShare(true)}>% share</button>
              </div>
            </div>
            <div className="chart-canvas-wrap" style={{ height: 320 }}>
              <ChartBox
                type="bar"
                data={{ labels: buckets.order.map((b) => prettyBucket(b, groupBy)), datasets: revDatasets }}
                options={stackedOpts(!revShare, revShare)}
              />
            </div>
          </div>

          {/* ── leads + deals ─────────────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Leads by channel</div>
              <div className="chart-sub">
                {leadDivs.length ? `Enquiries · ${leadDivs.join(" + ")}` : "Not available for this division"}
              </div>
              <div className="chart-canvas-wrap" style={{ height: 280 }}>
                {leadDivs.length ? (
                  <ChartBox
                    type="bar"
                    data={{ labels: buckets.order.map((b) => prettyBucket(b, groupBy)), datasets: leadDatasets }}
                    options={stackedOpts()}
                  />
                ) : (
                  <div className="empty-state" style={{ fontSize: 12, color: C.mid, textAlign: "center", padding: 30 }}>
                    Enquiries carry no off-plan flag, so leads can&apos;t be split off-plan vs secondary.
                  </div>
                )}
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-title">Deals by channel</div>
              <div className="chart-sub">Reservations + completions · {dealDivs.map((d) => DIV_LABEL[d]).join(" + ")}</div>
              <div className="chart-canvas-wrap" style={{ height: 280 }}>
                <ChartBox
                  type="bar"
                  data={{ labels: buckets.order.map((b) => prettyBucket(b, groupBy)), datasets: dealDatasets }}
                  options={stackedOpts()}
                />
              </div>
            </div>
          </div>

          {/* ── conversion by channel ─────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">Conversion rate by channel</div>
            <div className="chart-sub">Deals ÷ leads · {periodLabel}</div>
            <div className="chart-canvas-wrap" style={{ height: Math.max(180, convRows.length * 34) }}>
              {convRows.length ? (
                <ChartBox
                  type="bar"
                  data={{
                    labels: convRows.map((r) => r.channel),
                    datasets: [
                      {
                        label: "Conversion",
                        data: convRows.map((r) => (r.conv ?? 0) * 100),
                        backgroundColor: convRows.map((r) => CH_COLOR[r.channel] ?? C.mid),
                        borderWidth: 0,
                      },
                    ],
                  }}
                  options={{
                    indexAxis: "y" as const,
                    responsive: true,
                    plugins: {
                      legend: { display: false },
                      tooltip: { callbacks: { label: (ctx: any) => `${Number(ctx.raw).toFixed(2)}%` } },
                    },
                    scales: {
                      x: { beginAtZero: true, grid: { color: C.border }, ticks: { font: { size: 10 }, callback: (v: any) => `${v}%` } },
                      y: { grid: { display: false }, ticks: { font: { size: 10 }, autoSkip: false } },
                    },
                  }}
                />
              ) : (
                <div className="empty-state" style={{ fontSize: 12, color: C.mid, textAlign: "center", padding: 30 }}>
                  Conversion isn&apos;t available for this division.
                </div>
              )}
            </div>
          </div>

          {/* ── channel summary ──────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">Channel summary</div>
            <div className="chart-sub">{periodLabel} · sorted by revenue</div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th style={{ textAlign: "right" }}>Leads</th>
                    <th style={{ textAlign: "right" }}>Deals</th>
                    <th style={{ textAlign: "right" }}>Conversion</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th style={{ textAlign: "right" }}>Revenue %</th>
                    <th style={{ textAlign: "right" }}>Avg comm/deal</th>
                    <th style={{ textAlign: "right" }}>Lead %</th>
                    <th style={{ textAlign: "right" }}>Deal %</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((r) => (
                    <tr key={r.channel}>
                      <td>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: CH_COLOR[r.channel] ?? C.mid,
                            marginRight: 8,
                          }}
                        />
                        {r.channel}
                      </td>
                      <td style={{ textAlign: "right" }}>{leadDivs.length ? fmtInt(r.leads) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{fmtInt(r.deals)}</td>
                      <td style={{ textAlign: "right" }}>{fmtPct(r.conv, 2)}</td>
                      <td style={{ textAlign: "right" }}>{fmtAED(r.revenue)}</td>
                      <td style={{ textAlign: "right" }}>{fmtPct(r.revPct)}</td>
                      <td style={{ textAlign: "right" }}>{fmtAED(r.avgComm)}</td>
                      <td style={{ textAlign: "right" }}>{leadDivs.length ? fmtPct(r.leadPct) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{fmtPct(r.dealPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── contribution % ───────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Channel contribution</div>
                <div className="chart-sub">Share of total, {groupBy}ly</div>
              </div>
              <div className="ps-platforms">
                {(["leads", "deals", "revenue"] as const).map((m) => (
                  <button
                    key={m}
                    className={`filter-btn${contribMetric === m ? " active" : ""}`}
                    onClick={() => setContribMetric(m)}
                    disabled={m === "leads" && !leadDivs.length}
                  >
                    {m[0].toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="chart-canvas-wrap" style={{ height: 300 }}>
              <ChartBox
                type="bar"
                data={{ labels: buckets.order.map((b) => prettyBucket(b, groupBy)), datasets: contribDatasets }}
                options={stackedOpts(false, true)}
              />
            </div>
          </div>

          {/* ── full data ────────────────────────────────────────────────── */}
          <div className="chart-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Full data</div>
                <div className="chart-sub">Every month, division and channel — regardless of the filters above</div>
              </div>
              <button className="filter-btn" onClick={downloadCsv}>Download CSV</button>
            </div>
            <div className="table-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Channel</th>
                    <th>Division</th>
                    <th style={{ textAlign: "right" }}>Leads</th>
                    <th style={{ textAlign: "right" }}>Deals</th>
                    <th style={{ textAlign: "right" }}>Gross commission</th>
                  </tr>
                </thead>
                <tbody>
                  {fullRows.map((r, i) => (
                    <tr key={`${r.month}-${r.channel}-${r.division}-${i}`}>
                      <td>{r.month}</td>
                      <td>{r.channel}</td>
                      <td>{r.division}</td>
                      <td style={{ textAlign: "right" }}>{r.leads === "" ? "—" : fmtInt(r.leads)}</td>
                      <td style={{ textAlign: "right" }}>{r.deals ? fmtInt(r.deals) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{r.revenue ? fmtAED(r.revenue) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── method ───────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginTop: 20 }}>
            <div className="chart-title">Method &amp; data notes</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.85, marginTop: 8 }}>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Method.</strong> Deals are reservations and completions (withdrawn deals excluded), dated by
                reservation date. Revenue is final gross commission in AED. A deal&apos;s channel is the enquiry source of
                its originating lead; deals with no linked lead or no source appear as &ldquo;No Source&rdquo;.
                &ldquo;Other&rdquo; groups Website, Agent internal, WhatsApp, Google, Instagram, Previous seller/landlord
                and all smaller sources.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Division split.</strong> Deals are Sale vs Rent as recorded in the CRM; a sale is off-plan when
                its linked property is flagged &ldquo;Off Plan&rdquo;, and sales with no linked property count as
                secondary. Leads are Buyer and Seller enquiries (sales) vs Tenant and Landlord enquiries (leasing).
                Enquiries carry no off-plan flag, so lead counts and conversion aren&apos;t available for that split.
                &ldquo;No Source&rdquo; deals include deals with no linked lead, so their conversion rate isn&apos;t
                meaningful and shows as &ldquo;—&rdquo;.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Data notes.</strong> April 2025 lead volume includes a one-off bulk import of ~98,900
                unattributed enquiries — lead totals and overall conversion for that month, and for 2025 as a whole, are
                distorted. Channel-level figures other than &ldquo;No Source&rdquo; are unaffected.
              </p>
              <p style={{ margin: 0 }}>
                <strong>Not shown.</strong> Portal spend, cost per deal, revenue after portal expense and return on spend
                are omitted — the CRM holds no spend data. Figures cover {START_LABEL} onwards and update automatically
                as the CRM changes. Source: Engage CRM via Metabase.
              </p>
            </div>
          </div>
        </>
      )}
    </>
  );
}
