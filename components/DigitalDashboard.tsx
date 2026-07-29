"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { savePaidConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import { PLATFORMS, GOAL_LABELS, type PaidData, type PaidPlatform, type CampaignGoal } from "@/lib/paid";
import { ACCOUNT_CATALOG, VERIFIED_BLOCKED, type CatalogAccount } from "@/lib/paidAccounts";
import type { PaidConfig } from "@/lib/data";

const fmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n)));
const fmtK = (n: number | null | undefined) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
};
const money = (n: number | null | undefined, cur: string) =>
  n == null ? "—" : `${cur === "—" ? "" : cur + " "}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n))}`;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const pct1 = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(2)}%`);

const PLATFORM_ORDER: PaidPlatform[] = ["google", "meta", "linkedin"];
const PLATFORM_COLOR: Record<PaidPlatform, string> = {
  google: C.blue,
  meta: "#7c5cbf",
  linkedin: C.green,
};
const GOAL_COLOR: Record<CampaignGoal, string> = {
  leads: C.green,
  conversions: C.blue,
  traffic: C.sand,
  awareness: "#7c5cbf",
  engagement: C.coral,
  other: C.mid,
};

export default function DigitalDashboard({ initial, config }: { initial: PaidData; config: PaidConfig }) {
  const [data, setData] = useState<PaidData>(initial);
  const [days, setDays] = useState(30);
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [loading, setLoading] = useState(false);

  // Config editor. `sel` is the working copy and `savedSel` is what is actually
  // persisted, so closing without saving reverts rather than leaving the panel
  // showing ticks that no query will honour.
  const initialSel = useMemo<Record<PaidPlatform, string[]>>(
    () => ({
      google: config.accounts.google.map((a) => a.id),
      meta: config.accounts.meta.map((a) => a.id),
      linkedin: config.accounts.linkedin.map((a) => a.id),
    }),
    [config],
  );
  const [cfgOpen, setCfgOpen] = useState(initial.unconfigured);
  const [sel, setSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [savedSel, setSavedSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [showHidden, setShowHidden] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const key = (s: Record<PaidPlatform, string[]>) => PLATFORM_ORDER.map((p) => [...s[p]].sort().join(",")).join("|");
  const dirty = key(sel) !== key(savedSel);

  // View filters
  const [platformFilter, setPlatformFilter] = useState<"all" | PaidPlatform>("all");
  const [goalFilter, setGoalFilter] = useState<"all" | CampaignGoal>("all");

  const load = useCallback(async (qs: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/digital?${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) setData(json as PaidData);
      else console.error("[digital] refresh failed", json?.error ?? res.status);
    } catch (e) {
      console.error("[digital] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  function pickPreset(d: number) {
    setMode("preset");
    setDays(d);
    load(`days=${d}`);
  }
  function applyCustom() {
    if (!from || !to || from > to) return;
    setMode("custom");
    load(`from=${from}&to=${to}`);
  }

  function toggleAccount(p: PaidPlatform, id: string) {
    setCfgMsg(null);
    setSel((s) => ({ ...s, [p]: s[p].includes(id) ? s[p].filter((x) => x !== id) : [...s[p], id] }));
  }
  /** Tick or clear a whole platform — 41 Meta accounts is a lot of clicking. */
  function setPlatformAll(p: PaidPlatform, on: boolean, visible: CatalogAccount[]) {
    setCfgMsg(null);
    setSel((s) => ({ ...s, [p]: on ? [...new Set([...s[p], ...visible.map((a) => a.id)])] : s[p].filter((id) => !visible.some((a) => a.id === id)) }));
  }
  function closeConfig(revert: boolean) {
    if (revert) setSel(savedSel);
    setCfgMsg(null);
    setCfgOpen(false);
  }
  /** Save, refresh the data for the new selection, then close. */
  function saveAndClose() {
    setCfgMsg(null);
    startSave(async () => {
      const payload: Record<string, { id: string; name: string }[]> = {};
      for (const p of PLATFORM_ORDER) {
        payload[p] = sel[p].map((id) => ({ id, name: ACCOUNT_CATALOG[p].find((a) => a.id === id)?.name || id }));
      }
      const r = await savePaidConfigAction(payload);
      if (!r.ok) {
        // Stay open on failure — closing would imply the selection stuck.
        setCfgMsg(r.error || "Could not save.");
        return;
      }
      setSavedSel(sel);
      setCfgMsg(null);
      setCfgOpen(false);
      await load(mode === "custom" ? `from=${from}&to=${to}` : `days=${days}`);
    });
  }

  // ── Derived views ──────────────────────────────────────────────────────────
  const rows = useMemo(
    () =>
      data.rows.filter(
        (r) => (platformFilter === "all" || r.platform === platformFilter) && (goalFilter === "all" || r.goal === goalFilter),
      ),
    [data.rows, platformFilter, goalFilter],
  );

  /**
   * Spend is only summable within one currency. Accounts can be billed in
   * different ones, and adding AED to USD produces a number that means nothing,
   * so totals are kept per currency and the UI shows the split when there is
   * more than one rather than printing a single wrong figure.
   */
  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    let impressions = 0, clicks = 0, result = 0, leads = 0, websiteConv = 0, linkClicks = 0;
    for (const r of rows) {
      byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + r.cost);
      impressions += r.impressions;
      clicks += r.clicks;
      result += r.result;
      leads += (r.websiteLeads ?? 0) + (r.facebookLeads ?? 0);
      websiteConv += r.websiteConversions ?? 0;
      linkClicks += r.linkClicks ?? 0;
    }
    const curs = [...byCur.entries()].sort((a, b) => b[1] - a[1]);
    return {
      spendByCurrency: curs,
      singleCurrency: curs.length === 1 ? curs[0][0] : null,
      spend: curs.reduce((s, [, v]) => s + v, 0),
      impressions, clicks, result, leads, websiteConv, linkClicks,
      campaigns: rows.length,
    };
  }, [rows]);

  const byPlatform = useMemo(() => {
    const acc = new Map<PaidPlatform, { cost: number; impressions: number; clicks: number; result: number; campaigns: number; currencies: Set<string> }>();
    for (const r of rows) {
      const cur = acc.get(r.platform) ?? { cost: 0, impressions: 0, clicks: 0, result: 0, campaigns: 0, currencies: new Set<string>() };
      cur.cost += r.cost;
      cur.impressions += r.impressions;
      cur.clicks += r.clicks;
      cur.result += r.result;
      cur.campaigns += 1;
      cur.currencies.add(r.currency);
      acc.set(r.platform, cur);
    }
    return PLATFORM_ORDER.filter((p) => acc.has(p)).map((p) => ({ platform: p, ...acc.get(p)! }));
  }, [rows]);

  const byGoal = useMemo(() => {
    const acc = new Map<CampaignGoal, { cost: number; result: number; campaigns: number }>();
    for (const r of rows) {
      const cur = acc.get(r.goal) ?? { cost: 0, result: 0, campaigns: 0 };
      cur.cost += r.cost;
      cur.result += r.result;
      cur.campaigns += 1;
      acc.set(r.goal, cur);
    }
    return [...acc].map(([goal, v]) => ({ goal, ...v })).sort((a, b) => b.cost - a.cost);
  }, [rows]);

  const goalsPresent = useMemo(() => [...new Set(data.rows.map((r) => r.goal))], [data.rows]);
  const platformsPresent = useMemo(() => PLATFORM_ORDER.filter((p) => data.rows.some((r) => r.platform === p)), [data.rows]);
  const hasMeta = rows.some((r) => r.platform === "meta");

  const cur = totals.singleCurrency ?? "—";
  const cpc = ratio(totals.spend, totals.clicks);
  const cpl = ratio(totals.spend, totals.leads);
  const ctr = ratio(totals.clicks, totals.impressions);

  const selectedCount = PLATFORM_ORDER.reduce((n, p) => n + sel[p].length, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Digital Performance</h1>
          <p className="page-sub">
            Paid media across {PLATFORM_ORDER.map((p) => PLATFORMS[p].label).join(", ")} · via Supermetrics · {data.label}
            {loading ? " · refreshing…" : ""}
          </p>
        </div>
        <div className="filter-row" style={{ flexWrap: "wrap" }}>
          {[7, 30, 90].map((d) => (
            <button key={d} className={`filter-btn${mode === "preset" && days === d ? " active" : ""}`} onClick={() => pickPreset(d)}>
              {d}d
            </button>
          ))}
          <input type="date" className="search-box" style={{ width: 140 }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="search-box" style={{ width: 140 }} value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="filter-btn" onClick={applyCustom}>Apply</button>
          <button
            className={`filter-btn${cfgOpen ? " active" : ""}`}
            onClick={() => (cfgOpen ? closeConfig(true) : setCfgOpen(true))}
            title={`Choose which ad accounts appear — ${selectedCount} selected`}
            aria-label="Account settings"
          >
            ⚙ <span className="muted">{selectedCount}</span>
          </button>
        </div>
      </div>

      {/* ── Account picker ─────────────────────────────────────────────────── */}
      {cfgOpen && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <div className="chart-title">
            Accounts to showcase <HelpTip text="Only the accounts you tick are queried. The connected platforms expose far more than are actually advertised on — 41 Meta ad accounts alone, most of them closed, disabled, or messaging integrations." />
          </div>
          <div className="chart-sub">
            Pick the accounts that represent live activity. Closed, disabled and messaging-integration accounts are hidden by default.
          </div>
          <div style={{ display: "flex", gap: 6, margin: "10px 0", alignItems: "center", flexWrap: "wrap" }}>
            <button className="filter-btn" onClick={saveAndClose} disabled={saving}>
              {saving ? "Saving…" : "Save & close"}
            </button>
            <button className="filter-btn" onClick={() => closeConfig(true)} disabled={saving}>
              {dirty ? "Discard changes" : "Close"}
            </button>
            <button className="filter-btn" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide closed & integration accounts" : "Show all accounts"}
            </button>
            {dirty && !cfgMsg && <span className="muted" style={{ fontSize: 11 }}>Unsaved changes</span>}
            {cfgMsg && <span className="ps-save-msg" style={{ color: C.coral }}>{cfgMsg}</span>}
          </div>
          <div className="charts-grid-2">
            {PLATFORM_ORDER.map((p) => {
              const all = ACCOUNT_CATALOG[p];
              const visible = showHidden ? all : all.filter((a) => !a.disabled && !a.readOnly);
              const allOn = visible.length > 0 && visible.every((a) => sel[p].includes(a.id));
              return (
                <div key={p}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color: PLATFORM_COLOR[p] }}>{PLATFORMS[p].label}</span>
                    <span className="muted" style={{ fontSize: 11 }}>{sel[p].length}/{all.length} selected</span>
                    <button
                      className="filter-btn"
                      style={{ fontSize: 10, padding: "1px 7px", marginLeft: "auto" }}
                      onClick={() => setPlatformAll(p, !allOn, visible)}
                    >
                      {allOn ? "None" : "All shown"}
                    </button>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                    {visible.map((a) => (
                      <AccountRow key={a.id} acct={a} platform={p} checked={sel[p].includes(a.id)} onToggle={() => toggleAccount(p, a.id)} />
                    ))}
                    {!visible.length && <div className="muted" style={{ fontSize: 12 }}>None.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!data.connected ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>Supermetrics not connected</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.8 }}>
              Add to the deployment environment, then refresh:
              <br />
              {["SUPERMETRICS_API_KEY", "SUPERMETRICS_DS_USER"].map((l) => (
                <code key={l} style={{ display: "inline-block", margin: "2px 4px", background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>{l}</code>
              ))}
            </div>
          </div>
        </div>
      ) : data.unconfigured ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>No accounts selected yet</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.7, maxWidth: 520, margin: "0 auto" }}>
              Open <strong>Accounts</strong> above and tick the ad accounts you want on this dashboard. Nothing is selected by
              default — the connected platforms expose 41 Meta accounts, 5 Google Ads and 2 LinkedIn, and most of the Meta ones are
              closed or messaging integrations rather than live advertising.
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* An empty tab is never left to speak for itself — the reason comes
              from the data layer, which distinguishes "nothing spent" from
              "nothing readable". */}
          {data.error && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="empty-state" style={{ height: "auto", padding: "18px 16px", display: "block" }}>
                ⚠ {data.error}
              </div>
            </div>
          )}

          {/* ── KPIs ────────────────────────────────────────────────────────── */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">
                Spend <HelpTip text={totals.singleCurrency ? `Total media spend across the selected accounts, in ${totals.singleCurrency}. Source: Supermetrics.` : "The selected accounts bill in more than one currency, so a single total would be meaningless. The per-currency split is shown below. Source: Supermetrics."} />
              </div>
              <div className="kpi-value">
                {totals.singleCurrency ? money(totals.spend, cur) : <span style={{ fontSize: 15 }}>Mixed currency</span>}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Impressions <HelpTip text="Total impressions across the selected accounts and campaigns." /></div>
              <div className="kpi-value">{fmtK(totals.impressions)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                Clicks <HelpTip text="Total clicks. Google Ads and LinkedIn report all clicks; Meta has no all-clicks field in this set, so its link clicks are used." />
              </div>
              <div className="kpi-value">{fmtK(totals.clicks)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                Leads <HelpTip text="Meta website leads plus on-Facebook form leads. Google Ads and LinkedIn report conversions rather than a distinct lead metric, so they are counted under Results." />
              </div>
              <div className="kpi-value" style={{ color: C.green }}>{fmt(totals.leads)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                Results <HelpTip text="Each campaign's outcome measured against its own goal — leads for lead campaigns, link clicks for traffic, website conversions for sales, impressions for awareness. Summing them is a rollup of different things, so read it beside the goal breakdown." />
              </div>
              <div className="kpi-value">{fmt(totals.result)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                Efficiency <HelpTip text={`Derived from raw totals, not averaged from the platforms' own rate fields — Supermetrics pre-aggregates those and averaging them across rows is mathematically invalid.${totals.singleCurrency ? "" : " Hidden while accounts span multiple currencies."}`} />
              </div>
              <div className="kpi-value" style={{ fontSize: 15 }}>
                {totals.singleCurrency ? (
                  <>
                    CPC {cpc == null ? "—" : money(cpc, cur)}
                    {cpl != null && <> · CPL {money(cpl, cur)}</>}
                  </>
                ) : (
                  <>CTR {pct1(ctr)}</>
                )}
              </div>
            </div>
          </div>

          {totals.spendByCurrency.length > 1 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="chart-title">Spend by currency</div>
              <div className="chart-sub">
                The selected accounts are billed in {totals.spendByCurrency.length} currencies. These are not added together — no
                conversion rate is applied anywhere on this tab.
              </div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8 }}>
                {totals.spendByCurrency.map(([c, v]) => (
                  <div key={c}>
                    <div className="kpi-label">{c}</div>
                    <div style={{ fontFamily: "Georgia, serif", fontSize: 18, fontWeight: 700 }}>{money(v, c)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Filters ─────────────────────────────────────────────────────── */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            <button className={`filter-btn${platformFilter === "all" ? " active" : ""}`} onClick={() => setPlatformFilter("all")}>All platforms</button>
            {platformsPresent.map((p) => (
              <button key={p} className={`filter-btn${platformFilter === p ? " active" : ""}`} onClick={() => setPlatformFilter(p)}>
                {PLATFORMS[p].label}
              </button>
            ))}
            <span style={{ width: 12 }} />
            <button className={`filter-btn${goalFilter === "all" ? " active" : ""}`} onClick={() => setGoalFilter("all")}>All goals</button>
            {goalsPresent.map((g) => (
              <button key={g} className={`filter-btn${goalFilter === g ? " active" : ""}`} onClick={() => setGoalFilter(g)}>
                {GOAL_LABELS[g]}
              </button>
            ))}
          </div>

          {/* ── Trend + goal mix ────────────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Spend &amp; results over time</div>
              <div className="chart-sub">
                Daily · {data.label}
                {platformFilter !== "all" || goalFilter !== "all" ? " · trend covers all selected accounts, not the filters above" : ""}
              </div>
              <div className="chart-canvas-wrap">
                {data.byDate.length ? (
                  <ChartBox
                    type="line"
                    data={{
                      labels: data.byDate.map((d) => d.date.slice(5)),
                      datasets: [
                        { label: `Spend${cur !== "—" ? ` (${cur})` : ""}`, data: data.byDate.map((d) => d.cost), borderColor: C.blue, backgroundColor: "rgba(31,52,63,.08)", fill: true, tension: 0.3, yAxisID: "y" },
                        { label: "Results", data: data.byDate.map((d) => d.result), borderColor: C.green, backgroundColor: "transparent", tension: 0.3, yAxisID: "y1" },
                      ],
                    }}
                    options={{
                      interaction: { mode: "index", intersect: false },
                      scales: {
                        y: { beginAtZero: true, position: "left", title: { display: true, text: "Spend" } },
                        y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Results" } },
                      },
                    }}
                  />
                ) : (
                  <div className="empty-state">No daily data in range.</div>
                )}
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">
                Spend by campaign goal <HelpTip text="Where the money went, grouped by what each campaign was set up to achieve. Meta's objective is read from the campaign; Google Ads and LinkedIn report conversions and are grouped under Conversions." />
              </div>
              <div className="chart-sub">{byGoal.length} goal{byGoal.length === 1 ? "" : "s"} in range</div>
              <div className="chart-canvas-wrap">
                {byGoal.length ? (
                  <ChartBox
                    type="bar"
                    data={{
                      labels: byGoal.map((g) => GOAL_LABELS[g.goal]),
                      datasets: [{ label: "Spend", data: byGoal.map((g) => g.cost), backgroundColor: byGoal.map((g) => GOAL_COLOR[g.goal]), borderRadius: 5 }],
                    }}
                    options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }}
                  />
                ) : (
                  <div className="empty-state">No campaigns in range.</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Platform comparison ─────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title">Platform comparison</div>
            <div className="chart-sub">Totals per platform · {data.label}</div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Platform</th><th>Campaigns</th><th style={{ textAlign: "right" }}>Spend</th>
                    <th style={{ textAlign: "right" }}>Impressions</th><th style={{ textAlign: "right" }}>Clicks</th>
                    <th style={{ textAlign: "right" }}>CTR</th><th style={{ textAlign: "right" }}>Results</th>
                  </tr>
                </thead>
                <tbody>
                  {byPlatform.map((p) => {
                    const pc = p.currencies.size === 1 ? [...p.currencies][0] : "—";
                    return (
                      <tr key={p.platform}>
                        <td><span style={{ color: PLATFORM_COLOR[p.platform], fontWeight: 600 }}>{PLATFORMS[p.platform].label}</span></td>
                        <td>{p.campaigns}</td>
                        <td style={{ textAlign: "right" }}>{money(p.cost, pc)}</td>
                        <td style={{ textAlign: "right" }}>{fmtK(p.impressions)}</td>
                        <td style={{ textAlign: "right" }}>{fmtK(p.clicks)}</td>
                        <td style={{ textAlign: "right" }}>{pct1(ratio(p.clicks, p.impressions))}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p.result)}</td>
                      </tr>
                    );
                  })}
                  {!byPlatform.length && <tr><td colSpan={7} className="muted">No campaigns match the filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Campaign table ──────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title">
              Campaigns <HelpTip text="Every campaign with spend in range, biggest first. The Result column is goal-aware: it shows leads for lead campaigns, link clicks for traffic, website conversions for sales — the metric named beside it." />
            </div>
            <div className="chart-sub">
              {rows.length} campaign{rows.length === 1 ? "" : "s"}
              {platformFilter !== "all" ? ` · ${PLATFORMS[platformFilter as PaidPlatform].label}` : ""}
              {goalFilter !== "all" ? ` · ${GOAL_LABELS[goalFilter as CampaignGoal]}` : ""}
            </div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Campaign</th><th>Account</th><th>Goal</th>
                    <th style={{ textAlign: "right" }}>Spend</th>
                    <th style={{ textAlign: "right" }}>Impr.</th>
                    <th style={{ textAlign: "right" }}>Clicks</th>
                    <th style={{ textAlign: "right" }}>CTR</th>
                    <th style={{ textAlign: "right" }}>Result</th>
                    <th>Measured as</th>
                    <th style={{ textAlign: "right" }}>Cost / result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 60).map((r) => (
                    <tr key={`${r.platform}|${r.accountId}|${r.campaign}`}>
                      <td title={r.objective || undefined}>{r.campaign}</td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        <span style={{ color: PLATFORM_COLOR[r.platform] }}>●</span> {r.accountName}
                      </td>
                      <td><span style={{ color: GOAL_COLOR[r.goal], fontWeight: 600, fontSize: 11 }}>{GOAL_LABELS[r.goal]}</span></td>
                      <td style={{ textAlign: "right" }}>{money(r.cost, r.currency)}</td>
                      <td style={{ textAlign: "right" }}>{fmtK(r.impressions)}</td>
                      <td style={{ textAlign: "right" }}>{fmtK(r.clicks)}</td>
                      <td style={{ textAlign: "right" }}>{pct1(ratio(r.clicks, r.impressions))}</td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(r.result)}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{r.resultLabel}</td>
                      <td style={{ textAlign: "right" }}>{r.result > 0 ? money(r.cost / r.result, r.currency) : "—"}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={10} className="muted">No campaigns match the filters.</td></tr>}
                </tbody>
              </table>
            </div>
            {rows.length > 60 && <div className="chart-sub" style={{ marginTop: 8 }}>Showing the 60 highest-spending of {rows.length} campaigns.</div>}
          </div>

          {/* ── Meta outcome breakdown ──────────────────────────────────────── */}
          {hasMeta && (
            <div className="chart-card" style={{ marginTop: 4 }}>
              <div className="chart-title">
                Meta — all outcomes side by side <HelpTip text="Meta reports several outcomes for the same campaign at once, and which one matters depends on the objective. All four are shown so a campaign is never judged on a metric it was not buying." />
              </div>
              <div className="chart-sub">Link clicks, website conversions, website leads and on-Facebook form leads per campaign</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th>Campaign</th><th>Objective</th>
                      <th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Link clicks</th>
                      <th style={{ textAlign: "right" }}>Website conv.</th>
                      <th style={{ textAlign: "right" }}>Website leads</th>
                      <th style={{ textAlign: "right" }}>On-FB leads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r) => r.platform === "meta").slice(0, 40).map((r) => (
                      <tr key={`m|${r.accountId}|${r.campaign}`}>
                        <td>{r.campaign}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{r.objective || "—"}</td>
                        <td style={{ textAlign: "right" }}>{money(r.cost, r.currency)}</td>
                        <td style={{ textAlign: "right" }}>{fmt(r.linkClicks)}</td>
                        <td style={{ textAlign: "right" }}>{fmt(r.websiteConversions)}</td>
                        <td style={{ textAlign: "right" }}>{fmt(r.websiteLeads)}</td>
                        <td style={{ textAlign: "right" }}>{fmt(r.facebookLeads)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Accounts that could not be read ────────────────────────────── */}
          {data.failures.length > 0 && (
            <div className="chart-card" style={{ marginTop: 4 }}>
              <div className="chart-title">
                Accounts that could not be read ({data.failures.length}) <HelpTip text="Selected accounts that returned no data and why. Listed rather than silently omitted, because a missing account looks identical to a quiet one on the numbers above." />
              </div>
              <div className="chart-sub">These are excluded from every figure on this page.</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead><tr><th>Account</th><th>Platform</th><th>Reason</th></tr></thead>
                  <tbody>
                    {data.failures.map((f) => (
                      <tr key={`${f.platform}|${f.accountId}`}>
                        <td>{f.accountName}</td>
                        <td className="muted">{PLATFORMS[f.platform].label}</td>
                        {/* title carries the untouched response — the summary is
                            what belongs in the cell, but the raw body is still
                            one hover away when it isn't enough. */}
                        <td style={{ fontSize: 11, maxWidth: 520, whiteSpace: "normal" }} title={f.raw}>
                          {f.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.failures.some((f) => f.notPrioritised) && (
                <div className="chart-sub" style={{ marginTop: 10 }}>
                  Supermetrics only licenses a subset of ad accounts for querying. To change which ones, edit the prioritised
                  accounts on the{" "}
                  <a href="https://hub.supermetrics.com/token-management" target="_blank" rel="noopener noreferrer">Supermetrics hub</a>.
                </div>
              )}
              {/* An auth failure is a deployment variable, not a data problem, so
                  it gets told apart from everything else and names the fix. */}
              {data.failures.some((f) => f.authProblem) && (
                <div className="chart-sub" style={{ marginTop: 10 }}>
                  <strong>This is a configuration fix, not missing data.</strong> Supermetrics authorises each source to the person
                  who connected it, so every platform needs the login that authorised it:
                  {[...new Set(data.failures.filter((f) => f.authProblem).map((f) => f.platform))].map((p) => (
                    <div key={p} style={{ marginTop: 4 }}>
                      <code style={{ background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>{PLATFORMS[p].dsUserEnv}</code>{" "}
                      → {PLATFORMS[p].dsUserHint}
                    </div>
                  ))}
                  <div style={{ marginTop: 6 }}>
                    Confirm who owns each connection under{" "}
                    <a href="https://hub.supermetrics.com/token-management" target="_blank" rel="noopener noreferrer">token management</a>, then
                    add those variables to the deployment.
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="chart-sub" style={{ marginTop: 14 }}>
            Sources: {data.accountsUsed.length} ad account{data.accountsUsed.length === 1 ? "" : "s"} with data via Supermetrics
            {data.emptyAccounts.length ? ` · ${data.emptyAccounts.length} read but had no activity in range (${data.emptyAccounts.map((a) => a.name).join(", ")})` : ""}
            {data.failures.length ? ` · ${data.failures.length} unavailable` : ""} · rates are derived from raw totals, never
            averaged from the platforms&apos; own pre-aggregated rate fields.
          </div>
        </>
      )}
    </div>
  );
}

function AccountRow({ acct, platform, checked, onToggle }: { acct: CatalogAccount; platform: PaidPlatform; checked: boolean; onToggle: () => void }) {
  const blocked = VERIFIED_BLOCKED[platform].includes(acct.id);
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{ flex: 1 }}>
        {acct.name}
        {acct.disabled && <span className="muted" style={{ fontSize: 10 }}> · closed</span>}
        {acct.readOnly && <span className="muted" style={{ fontSize: 10 }}> · integration</span>}
        {blocked && (
          <span style={{ fontSize: 10, color: C.coral }} title="Rejected by Supermetrics as not a prioritised account when this was built">
            {" "}· not licensed
          </span>
        )}
      </span>
    </label>
  );
}
