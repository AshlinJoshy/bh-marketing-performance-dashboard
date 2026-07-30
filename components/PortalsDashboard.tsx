"use client";

// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) and
// the unit economics of it.
//
// The CRM holds NO spend data, so spend is an input: an annual figure (default
// AED 10M) pro-rated to the selected window and split across portals. Everything
// derived from it — cost per lead, cost per deal, return on spend — is therefore
// an ESTIMATE, and is labelled as one everywhere it appears. The alternative was
// leaving the tab without unit economics at all, which is what Company
// Performance does today.
//
// Only the range and brand refetch (they change the SQL). Spend and its split
// recompute client-side, so dragging the spend figure is instant.
import { useCallback, useMemo, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker from "@/components/DateRangePicker";
import { C } from "@/lib/theme";
import { DEFAULT_ANNUAL_SPEND, defaultSplit, spendForPeriod, type PortalsData } from "@/lib/portals";

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

  // Spend inputs. Held as a string so a half-typed figure doesn't snap to 0.
  const [annualStr, setAnnualStr] = useState(String(DEFAULT_ANNUAL_SPEND));
  const annual = Math.max(0, Number(annualStr.replace(/[^0-9.]/g, "")) || 0);
  /** Manual per-portal share overrides, as percentages. Empty = use the lead-share default. */
  const [splitOverride, setSplitOverride] = useState<Record<string, string>>({});
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

  /** Effective share per portal: manual override where given, lead share otherwise. */
  const shares = useMemo(() => {
    const auto = defaultSplit(rows);
    const manual: Record<string, number> = {};
    let manualTotal = 0;
    for (const r of rows) {
      const raw = splitOverride[r.portal];
      if (raw != null && raw !== "") {
        const v = Math.max(0, Number(raw) || 0) / 100;
        manual[r.portal] = v;
        manualTotal += v;
      }
    }
    const untouched = rows.filter((r) => manual[r.portal] == null);
    // Whatever the manual entries didn't claim is shared out by lead weight, so
    // the split always sums to 1 and spend is never quietly lost or doubled.
    const remaining = Math.max(0, 1 - manualTotal);
    const autoWeight = untouched.reduce((s, r) => s + (auto[r.portal] ?? 0), 0);
    const out: Record<string, number> = { ...manual };
    for (const r of untouched) {
      out[r.portal] = autoWeight > 0 ? remaining * ((auto[r.portal] ?? 0) / autoWeight) : remaining / (untouched.length || 1);
    }
    return out;
  }, [rows, splitOverride]);

  const periodSpend = spendForPeriod(annual, data.months.length);

  /** Per-portal economics. Rates are null rather than 0 when the denominator is 0. */
  const econ = useMemo(
    () =>
      rows.map((r) => {
        const spend = periodSpend * (shares[r.portal] ?? 0);
        return {
          ...r,
          spend,
          cpl: r.leads > 0 ? spend / r.leads : null,
          cpd: r.deals > 0 ? spend / r.deals : null,
          conv: r.leads > 0 ? r.deals / r.leads : null,
          net: r.commission - spend,
          roas: spend > 0 ? r.commission / spend : null,
          share: shares[r.portal] ?? 0,
        };
      }),
    [rows, shares, periodSpend],
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
        { label: "Estimated spend", data: econ.map((r) => r.spend), backgroundColor: C.sand, borderRadius: 4 },
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
        <label className="search-box" style={{ display: "flex", alignItems: "center", gap: 6, width: 250 }}>
          <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid, whiteSpace: "nowrap" }}>
            Annual spend
          </span>
          <input
            value={annualStr}
            onChange={(e) => setAnnualStr(e.target.value)}
            inputMode="numeric"
            style={{ border: 0, outline: "none", background: "transparent", width: "100%", fontSize: 12, color: C.dark }}
            aria-label="Annual portal spend in AED"
          />
        </label>
        <HelpTip text="Total portal spend for a full year, in AED. The CRM holds no spend data, so this is your figure — it defaults to AED 10M. It is pro-rated to the selected period by month count, so cost per lead stays comparable when you change the range." />
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

      {/* ── the estimate banner. Every figure below leans on this. ── */}
      <div className="chart-card" style={{ marginBottom: 18, borderColor: C.sand, background: "#fffdf7" }}>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          <strong>Cost figures are estimates.</strong> The CRM records no portal spend, so{" "}
          <strong>{fmtAED(annual)}/year</strong> is an assumption — pro-rated to{" "}
          <strong>{fmtAED(periodSpend)}</strong> over the {data.months.length} month
          {data.months.length === 1 ? "" : "s"} in view, then split across portals. Leads, deals and
          commission are live CRM figures; cost per lead, cost per deal and return on spend are derived
          from the assumption and move with it.
        </div>
      </div>

      {/* ── KPIs ─────────────────────────────────────────────────── */}
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {[
          { label: "Portal leads", value: fmtInt(tot.leads), tip: "Leads whose enquiry_source is Property Finder, Bayut or Dubizzle, created in the selected period." },
          { label: "Portal deals", value: fmtInt(tot.deals), tip: "Deals (Reserved/Closed/Completed, not Withdrawn) dated by reservation, whose originating lead came from a portal." },
          { label: "Lead → deal", value: fmtPct(tot.conv), tip: "Portal deals ÷ portal leads in the same period. A deal can be reserved in a later month than its lead arrived, so this is a period ratio, not a cohort conversion." },
          { label: "Gross commission", value: fmtAED(tot.commission), color: C.green, tip: "final_gross_commission_amount summed over portal deals." },
          { label: "Estimated spend", value: fmtAED(tot.spend), tip: "Your annual figure pro-rated to this period." },
          { label: "Cost / lead", value: fmtAEDExact(tot.cpl), tip: "Estimated spend ÷ portal leads. Estimate." },
          { label: "Cost / deal", value: fmtAEDExact(tot.cpd), tip: "Estimated spend ÷ portal deals. Estimate." },
          { label: "Return on spend", value: fmtX(tot.roas), color: (tot.roas ?? 0) >= 1 ? C.green : C.red, tip: "Gross commission ÷ estimated spend. Above 1× means commission exceeded the assumed spend. Estimate." },
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
          Spend share defaults to each portal&apos;s share of leads — the only portal-relative volume the CRM
          has. Real invoices track listing credits, so override the share if you know the actual split.
          Anything you leave blank shares out the remainder by lead weight.
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
                <th>Spend share</th>
                <th>Est. spend</th>
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
                      value={splitOverride[r.portal] ?? ""}
                      placeholder={(r.share * 100).toFixed(0)}
                      onChange={(e) => setSplitOverride((s) => ({ ...s, [r.portal]: e.target.value }))}
                      inputMode="numeric"
                      style={{ width: 52, textAlign: "right" as const, fontSize: 11, padding: "2px 4px", border: `1px solid var(--border)`, borderRadius: 4 }}
                      aria-label={`${r.portal} spend share, percent`}
                    />
                    <span style={{ fontSize: 10, color: C.mid }}> %</span>
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
                <td>100 %</td>
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
            Estimated. Toggle &ldquo;Cost / deal&rdquo; in the legend — it&apos;s an order of magnitude larger, so
            it starts hidden to keep the lead bars readable.
          </p>
          <div style={{ height: 260 }}>
            <ChartBox type="bar" data={costChart} options={baseOpts} />
          </div>
        </div>
        <div className="chart-card">
          <h3 style={{ marginBottom: 4 }}>Estimated spend vs gross commission</h3>
          <p style={{ fontSize: 11, color: C.mid, marginBottom: 8 }}>
            Commission is live; spend is your assumption apportioned per portal.
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
