"use client";

// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) and
// the unit economics of it.
//
// Spend is REAL, from the PPA workbook's monthly expense schedule (see
// lib/portalSpend.ts) — not an assumption. Only spend is taken from that
// workbook; deals, leads and commission stay live from the CRM, so cost per deal
// is a measured spend over a measured deal count and the two can't drift apart.
//
// Spend is applied as each portal's AVERAGE monthly rate times the months in
// view. A rate rather than a month-exact lookup, so ranges the workbook doesn't
// cover still cost something instead of silently reading as free.
//
// Only the range and brand refetch (they change the SQL). Spend recomputes
// client-side, so editing a rate is instant.
import { useCallback, useMemo, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker from "@/components/DateRangePicker";
import { C } from "@/lib/theme";
import type { PortalsData } from "@/lib/portals";
import { SPEND_IS_MONTHLY, SPEND_MONTHS, SPEND_SOURCE_LABEL, avgMonthlySpend, avgMonthlySpendTotal } from "@/lib/portalSpend";

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const fmtAED = (n: number) => {
  const a = Math.abs(n || 0);
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
};
/** Exact dirhams — for per-unit costs, where rounding to "K" would hide the number. */
const fmtAEDExact = (n: number | null) =>
  n == null || !Number.isFinite(n) ? "—" : `AED ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;
const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);
const fmtX = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}×`);

const PORTAL_COLOR: Record<string, string> = {
  "Property Finder": C.amber,
  Bayut: C.green,
  Dubizzle: C.red,
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => {
  const [y, mm] = m.split("-");
  return `${MONTH_SHORT[Number(mm) - 1] ?? mm} ${String(y).slice(2)}`;
};

type Metric = "leads" | "deals" | "commission";

/** Placeholder shaped like the real body, so the layout doesn't jump on load. */
function PortalsSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div className="kpi-card" key={i}>
            <div className="skeleton" style={{ width: "60%", height: 9, marginBottom: 10 }} />
            <div className="skeleton" style={{ width: "45%", height: 20 }} />
          </div>
        ))}
      </div>
      {[300, 260, 300].map((h, i) => (
        <div className="chart-card" key={i} style={{ marginBottom: 18 }}>
          <div className="skeleton" style={{ width: 160, height: 12, marginBottom: 14 }} />
          <div className="skeleton" style={{ width: "100%", height: h }} />
        </div>
      ))}
    </div>
  );
}

export default function PortalsDashboard({ initial }: { initial: PortalsData }) {
  const [data, setData] = useState<PortalsData>(initial);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [brand, setBrand] = useState(initial.brand);

  /**
   * Per-portal monthly spend override, AED. Empty = the real average from the
   * PPA workbook. There is no single "total spend" input any more: spend is
   * known per portal, so a total would have to be split by a guess.
   */
  const [rateOverride, setRateOverride] = useState<Record<string, string>>({});
  const [metric, setMetric] = useState<Metric>("leads");
  const [areaQuery, setAreaQuery] = useState("");

  const load = useCallback(async (f: string, t: string, b: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: f, to: t });
      if (b) qs.set("brand", b);
      const res = await fetch(`/api/portals?${qs}`, { cache: "no-store" });
      const j = (await res.json()) as PortalsData;
      if (!("error" in j) || j.portals) setData(j);
    } catch {
      /* keep the previous payload rather than blanking the page */
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Range and brand fetch straight from their handlers rather than via an effect
   * — same as Company Performance. An effect would re-run on every render that
   * touched the key and needs a setState inside it to show the spinner.
   */
  const pickRange = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
    load(f, t, brand);
  };
  const pickBrand = (b: string) => {
    setBrand(b);
    load(from, to, b);
  };

  const rows = data.rows;

  /** Monthly rate per portal: the override if given, else the workbook average. */
  const rateFor = useCallback(
    (portal: string) => {
      const raw = rateOverride[portal];
      if (raw != null && raw !== "") return Math.max(0, Number(raw.replace(/[^0-9.]/g, "")) || 0);
      return avgMonthlySpend(portal);
    },
    [rateOverride],
  );

  const monthCount = data.months.length;
  const anyOverride = Object.values(rateOverride).some((v) => v !== "");

  /**
   * Per-portal economics. Spend is the portal's monthly rate times the months in
   * view — measured, not apportioned. Rates are null rather than 0 when the
   * denominator is 0, so "no deals" never renders as "zero cost".
   */
  const econ = useMemo(
    () =>
      rows.map((r) => {
        const rate = rateFor(r.portal);
        const spend = rate * monthCount;
        return {
          ...r,
          rate,
          spend,
          cpl: r.leads > 0 ? spend / r.leads : null,
          cpd: r.deals > 0 ? spend / r.deals : null,
          conv: r.leads > 0 ? r.deals / r.leads : null,
          net: r.commission - spend,
          roas: spend > 0 ? r.commission / spend : null,
        };
      }),
    [rows, rateFor, monthCount],
  );

  const tot = useMemo(() => {
    const leads = econ.reduce((s, r) => s + r.leads, 0);
    const deals = econ.reduce((s, r) => s + r.deals, 0);
    const commission = econ.reduce((s, r) => s + r.commission, 0);
    const spend = econ.reduce((s, r) => s + r.spend, 0);
    return {
      leads,
      deals,
      commission,
      spend,
      cpl: leads > 0 ? spend / leads : null,
      cpd: deals > 0 ? spend / deals : null,
      conv: leads > 0 ? deals / leads : null,
      net: commission - spend,
      roas: spend > 0 ? commission / spend : null,
    };
  }, [econ]);

  const series = metric === "leads" ? data.leadsByMonth : metric === "deals" ? data.dealsByMonth : data.commByMonth;
  const labels = data.months.map(monthLabel);

  // Hoisted so the dep arrays hold plain identifiers — the lint rule rejects
  // expressions like `xs.join("|")` inline.
  const labelKey = labels.join("|");
  const portalKey = data.portals.join("|");
  const seriesKey = JSON.stringify(series);

  const trend = useMemo(
    () => ({
      labels,
      datasets: data.portals.map((p) => ({
        label: p,
        data: series[p] ?? [],
        borderColor: PORTAL_COLOR[p] ?? C.mid,
        backgroundColor: `${PORTAL_COLOR[p] ?? C.mid}22`,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: labels.length > 18 ? 0 : 3,
        fill: false,
      })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelKey, metric, portalKey, seriesKey],
  );

  const costChart = useMemo(
    () => ({
      labels: econ.map((r) => r.portal),
      datasets: [
        { label: "Cost / lead", data: econ.map((r) => r.cpl ?? 0), backgroundColor: C.blue, borderRadius: 4 },
        { label: "Cost / deal", data: econ.map((r) => r.cpd ?? 0), backgroundColor: C.amber, borderRadius: 4, hidden: true },
      ],
    }),
    [econ],
  );

  const spendVsComm = useMemo(
    () => ({
      labels: econ.map((r) => r.portal),
      datasets: [
        { label: "Portal spend", data: econ.map((r) => r.spend), backgroundColor: C.sand, borderRadius: 4 },
        { label: "Gross commission", data: econ.map((r) => r.commission), backgroundColor: C.green, borderRadius: 4 },
      ],
    }),
    [econ],
  );

  const areas = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    return q ? data.areas.filter((a) => a.area.toLowerCase().includes(q)) : data.areas;
  }, [data.areas, areaQuery]);

  const areaChart = useMemo(() => {
    const top = areas.slice(0, 15);
    return {
      labels: top.map((a) => a.area),
      datasets: [{ label: "Listings", data: top.map((a) => a.listings), backgroundColor: C.blue, borderRadius: 4 }],
    };
  }, [areas]);

  const totalListings = data.areas.reduce((s, a) => s + a.listings, 0);

  const baseOpts = {
    responsive: true,
    plugins: { legend: { position: "bottom" as const, labels: { boxWidth: 12, font: { size: 11 } } } },
    scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
  };

  if (!data.connected) {
    return (
      <div className="chart-card">
        <h2>Portals</h2>
        <p style={{ color: C.mid, fontSize: 13 }}>
          Not connected to the CRM. Set <code>METABASE_URL</code> and either <code>METABASE_API_KEY</code> or{" "}
          <code>METABASE_USERNAME</code> / <code>METABASE_PASSWORD</code>.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="filter-grid" style={{ marginBottom: 18 }}>
        <DateRangePicker initialKey="this_year" initialFrom={from} initialTo={to} onApply={pickRange} />
        <select className="search-box" style={{ width: 150 }} value={brand} onChange={(e) => pickBrand(e.target.value)} aria-label="Brand">
          {data.brands.map((b) => (
            <option key={b.key} value={b.key}>{b.label}</option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: C.mid, alignSelf: "center" }}>
          Spend: {fmtAED(avgMonthlySpendTotal())}/month avg
          {anyOverride ? <strong style={{ color: C.amber }}> (edited)</strong> : null}
        </span>
        <HelpTip text={`Real monthly portal spend from ${SPEND_SOURCE_LABEL}. Each portal's average monthly rate is multiplied by the months in view. Override any portal's rate in the table below.`} />
      </div>

      {/* Everything below waits for the whole payload — a partial fill would show
          cost per lead against a lead count that hasn't landed yet. */}
      {loading ? (
        <PortalsSkeleton />
      ) : (
        <>


      {data.error && (
        <div className="chart-card" style={{ marginBottom: 18, borderColor: C.red }}>
          <strong style={{ color: C.red }}>CRM error.</strong> <span style={{ fontSize: 13 }}>{data.error}</span>
        </div>
      )}
      {data.warnings.map((w) => (
        <div key={w} className="chart-card" style={{ marginBottom: 12, borderColor: C.amber }}>
          <span style={{ fontSize: 13 }}>⚠ {w}</span>
        </div>
      ))}

      {/* ── where spend comes from ─────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 18, borderColor: C.sage, background: "#f8fbf8" }}>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          <strong>Spend is actual, not assumed.</strong> Monthly portal spend comes from{" "}
          <strong>{SPEND_SOURCE_LABEL}</strong> — {fmtAED(avgMonthlySpendTotal())}/month on average across the
          three portals ({fmtAED(avgMonthlySpendTotal() * 12)} a year). Each portal&apos;s average rate is
          applied to the <strong>{monthCount} month{monthCount === 1 ? "" : "s"}</strong> in view, giving{" "}
          <strong>{fmtAED(tot.spend)}</strong>. Deals, leads and commission are live CRM figures, so cost per
          deal divides measured spend by a measured deal count.
        </div>
        <div style={{ fontSize: 12, color: C.mid, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <strong>Two caveats.</strong> Property Finder and Bayut have true month-by-month schedules; Dubizzle
          appears in the workbook only as a period total, so its monthly figure is that total spread evenly over{" "}
          {SPEND_MONTHS} months — right in size, assumed in shape. And an average rate means a range shorter
          than a full year won&apos;t reflect a mid-year rate change (Property Finder&apos;s April 2025 spike,
          Bayut&apos;s June 2025 increase); override the rate in the table to model a specific period.
        </div>
        <div style={{ fontSize: 11.5, color: C.mid, marginTop: 8 }}>
          For the record, the CRM itself was searched for spend:{" "}
          {data.spendCandidates.length === 0
            ? "nothing in its schema names spend, cost, budget, invoice or subscription — the workbook is the only source."
            : `possible fields exist (${data.spendCandidates.slice(0, 6).join(", ")}); the workbook is used in preference, but say the word and one of those can be read live instead.`}
        </div>
      </div>

      {/* ── KPIs ─────────────────────────────────────────────────── */}
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {[
          { label: "Portal leads", value: fmtInt(tot.leads), tip: "Leads whose enquiry_source is Property Finder, Bayut or Dubizzle, created in the selected period." },
          { label: "Portal deals", value: fmtInt(tot.deals), tip: "Deals (Reserved/Closed/Completed, not Withdrawn) dated by reservation, whose originating lead came from a portal." },
          { label: "Lead → deal", value: fmtPct(tot.conv), tip: "Portal deals ÷ portal leads in the same period. A deal can be reserved in a later month than its lead arrived, so this is a period ratio, not a cohort conversion." },
          { label: "Gross commission", value: fmtAED(tot.commission), color: C.green, tip: "final_gross_commission_amount summed over portal deals." },
          { label: "Portal spend", value: fmtAED(tot.spend), tip: `Actual spend from ${SPEND_SOURCE_LABEL} — each portal's average monthly rate times the months in view.` },
          { label: "Cost / lead", value: fmtAEDExact(tot.cpl), tip: "Portal spend ÷ portal leads." },
          { label: "Cost / deal", value: fmtAEDExact(tot.cpd), tip: "Portal spend ÷ portal deals. Both sides measured: spend from the workbook, deals from the CRM." },
          { label: "Return on spend", value: fmtX(tot.roas), color: (tot.roas ?? 0) >= 1 ? C.green : C.red, tip: "Gross commission ÷ portal spend. Above 1× means commission exceeded spend." },
        ].map((k) => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-label">
              {k.label} <HelpTip text={k.tip} />
            </div>
            <div className="kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* ── per-portal table, with the spend split editable inline ── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>By portal</h3>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          Monthly spend is the actual figure from the workbook. Override a portal&apos;s rate to model a
          different period or a renegotiated contract — blank uses the workbook average.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="perf-table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Portal</th>
                <th>Leads</th>
                <th>Deals</th>
                <th>Lead → deal</th>
                <th>Gross commission</th>
                <th>Spend / month</th>
                <th>Spend in period</th>
                <th>Cost / lead</th>
                <th>Cost / deal</th>
                <th>Net</th>
                <th>RoS</th>
              </tr>
            </thead>
            <tbody>
              {econ.map((r) => (
                <tr key={r.portal}>
                  <td>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: PORTAL_COLOR[r.portal] ?? C.mid, marginRight: 7 }} />
                    {r.portal}
                  </td>
                  <td>{fmtInt(r.leads)}</td>
                  <td>{fmtInt(r.deals)}</td>
                  <td>{fmtPct(r.conv)}</td>
                  <td style={{ color: C.green }}>{fmtAED(r.commission)}</td>
                  <td>
                    <input
                      value={rateOverride[r.portal] ?? ""}
                      placeholder={fmtInt(avgMonthlySpend(r.portal))}
                      onChange={(e) => setRateOverride((prev) => ({ ...prev, [r.portal]: e.target.value }))}
                      inputMode="numeric"
                      style={{ width: 82, textAlign: "right", fontSize: 11, padding: "2px 4px", border: "1px solid var(--border)", borderRadius: 4 }}
                      aria-label={`${r.portal} monthly spend in AED`}
                    />
                    {!SPEND_IS_MONTHLY[r.portal] && (
                      <span title="Period total spread evenly — the workbook has no monthly column for this portal." style={{ fontSize: 10, color: C.amber, marginLeft: 4 }}>~</span>
                    )}
                  </td>
                  <td>{fmtAED(r.spend)}</td>
                  <td>{fmtAEDExact(r.cpl)}</td>
                  <td>{fmtAEDExact(r.cpd)}</td>
                  <td style={{ color: r.net >= 0 ? C.green : C.red }}>{fmtAED(r.net)}</td>
                  <td>{fmtX(r.roas)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 600, borderTop: `2px solid var(--border)` }}>
                <td>Total</td>
                <td>{fmtInt(tot.leads)}</td>
                <td>{fmtInt(tot.deals)}</td>
                <td>{fmtPct(tot.conv)}</td>
                <td style={{ color: C.green }}>{fmtAED(tot.commission)}</td>
                <td>{fmtAED(econ.reduce((a, r) => a + r.rate, 0))}</td>
                <td>{fmtAED(tot.spend)}</td>
                <td>{fmtAEDExact(tot.cpl)}</td>
                <td>{fmtAEDExact(tot.cpd)}</td>
                <td style={{ color: tot.net >= 0 ? C.green : C.red }}>{fmtAED(tot.net)}</td>
                <td>{fmtX(tot.roas)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── trend ────────────────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Over time</h3>
          <div style={{ display: "flex", gap: 6 }}>
            {(["leads", "deals", "commission"] as Metric[]).map((m) => (
              <button key={m} className={`filter-btn${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>
                {m === "commission" ? "Commission" : m === "leads" ? "Leads" : "Deals"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ height: 300 }}>
          <ChartBox type="line" data={trend} options={baseOpts} />
        </div>
      </div>

      <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 18, marginBottom: 20 }}>
        <div className="chart-card">
          <h3 style={{ marginBottom: 4 }}>Cost per lead & per deal</h3>
          <p style={{ fontSize: 11, color: C.mid, marginBottom: 8 }}>
Toggle &ldquo;Cost / deal&rdquo; in the legend — it&apos;s an order of magnitude larger, so
            it starts hidden to keep the lead bars readable.
          </p>
          <div style={{ height: 260 }}>
            <ChartBox type="bar" data={costChart} options={baseOpts} />
          </div>
        </div>
        <div className="chart-card">
          <h3 style={{ marginBottom: 4 }}>Spend vs gross commission</h3>
          <p style={{ fontSize: 11, color: C.mid, marginBottom: 8 }}>
            Both measured — commission from the CRM, spend from the workbook.
          </p>
          <div style={{ height: 260 }}>
            <ChartBox type="bar" data={spendVsComm} options={baseOpts} />
          </div>
        </div>
      </div>

      {/* ── listings by area ─────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>
            Listings by area{" "}
            <HelpTip
              text={
                data.areaSource
                  ? `Live listings grouped by ${data.areaSource}, discovered from the database schema rather than hardcoded. Not filtered by the date range — a listing count is a snapshot of now, not a period total.`
                  : "No area column could be found on properties or listings."
              }
            />
          </h3>
          <input
            className="search-box"
            style={{ width: 200 }}
            placeholder="Search area…"
            value={areaQuery}
            onChange={(e) => setAreaQuery(e.target.value)}
          />
        </div>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          {fmtInt(totalListings)} listings across {fmtInt(data.areas.length)} areas
          {data.areaSource ? <> · grouped by <code>{data.areaSource}</code></> : null} · a snapshot of now, not
          the selected period.
        </p>
        {data.listingsNote && (
          <p style={{ fontSize: 12, color: C.amber, marginBottom: 10 }}>⚠ {data.listingsNote}</p>
        )}
        {areas.length === 0 ? (
          <p style={{ fontSize: 13, color: C.mid }}>No areas to show.</p>
        ) : (
          <>
            <div style={{ height: 300, marginBottom: 14 }}>
              <ChartBox type="bar" data={areaChart} options={{ ...baseOpts, indexAxis: "y" as const, plugins: { legend: { display: false } } }} />
            </div>
            <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
              <table className="perf-table" style={{ minWidth: 320 }}>
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Listings</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {areas.map((a) => (
                    <tr key={a.area}>
                      <td>{a.area}</td>
                      <td>{fmtInt(a.listings)}</td>
                      <td>{totalListings ? fmtPct(a.listings / totalListings) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── what ISN'T counted as a portal ───────────────────────── */}
      {data.unmappedSources.length > 0 && (
        <div className="chart-card">
          <h3 style={{ marginBottom: 4 }}>
            Other lead sources, not counted as portals <HelpTip text="Every enquiry_source in this period that isn't Property Finder, Bayut or Dubizzle. Listed so a portal we haven't mapped — a new one, or a spelling variant — shows up as a number to ask about instead of quietly missing from the figures above." />
          </h3>
          <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
            If a portal is missing from the table above, it will be in this list. Tell me which and it gets mapped.
          </p>
          <div style={{ overflowX: "auto", maxHeight: 260, overflowY: "auto" }}>
            <table className="perf-table" style={{ minWidth: 300 }}>
              <thead><tr><th>enquiry_source</th><th>Leads</th></tr></thead>
              <tbody>
                {data.unmappedSources.map((s) => (
                  <tr key={s.source}><td>{s.source}</td><td>{fmtInt(s.n)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </>
      )}
    </>
  );
}
