"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { savePaidConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import { PLATFORMS, GOAL_LABELS, type PaidData, type PaidPlatform, type CampaignGoal, type PaidLevel, type CampaignRow } from "@/lib/paid";
import { ACCOUNT_CATALOG, VERIFIED_BLOCKED, type CatalogAccount } from "@/lib/paidAccounts";
import type { CampaignLeadsData } from "@/lib/metabase";
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
const pct0 = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(n * 100 >= 10 ? 0 : 1)}%`);

const PLATFORM_ORDER: PaidPlatform[] = ["google", "meta", "linkedin"];
const PLATFORM_COLOR: Record<PaidPlatform, string> = { google: C.blue, meta: "#7c5cbf", linkedin: C.green };
const GOAL_COLOR: Record<CampaignGoal, string> = {
  leads: C.green, conversions: C.blue, traffic: C.sand, awareness: "#7c5cbf", engagement: C.coral, other: C.mid,
};

/** Same pipeline vocabulary the SEO tab uses for the same CRM column. */
const STAGE_ORDER = ["New", "Qualified", "Viewing", "Listed", "Valuation", "Reserved", "Offer", "Deal"];
const stageIdx = (s: string) => {
  const i = STAGE_ORDER.findIndex((x) => x.toLowerCase() === s.toLowerCase());
  return i === -1 ? 0 : i;
};

const norm = (s: string) => s.toLowerCase().trim();

/**
 * utm_source spellings that mean each platform. Used only to narrow the CRM
 * side when a platform filter is on — it is a heuristic over free-text tags,
 * and the tooltip says so.
 */
const SRC_OF_PLATFORM: Record<PaidPlatform, string[]> = {
  google: ["google", "adwords", "google_ads", "googleads", "google-ads"],
  meta: ["facebook", "fb", "instagram", "ig", "meta", "meta_ads"],
  linkedin: ["linkedin", "li"],
};

const LEVEL_LABEL: Record<PaidLevel, string> = { campaign: "Campaigns", adset: "Ad sets", ad: "Ads" };

type CrmJoin = { leads: number; qualified: number; deals: number };

// Default custom-range inputs. Evaluated once at module load, so the clock read
// never happens during render.
const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const DEFAULT_TO = ymdOf(Date.now());
const DEFAULT_FROM = ymdOf(Date.now() - 29 * 864e5);

export default function DigitalDashboard({ initial, config }: { initial: PaidData | null; config: PaidConfig }) {
  // `initial` is null on purpose: the server renders the shell without waiting
  // on Supermetrics (up to 25s per account), and the media numbers stream in
  // here behind a skeleton instead of blocking the navigation.
  const [data, setData] = useState<PaidData | null>(initial);
  const [level, setLevel] = useState<PaidLevel>("campaign");
  const [days, setDays] = useState(30);
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [from, setFrom] = useState(initial?.from ?? DEFAULT_FROM);
  const [to, setTo] = useState(initial?.to ?? DEFAULT_TO);
  const [loading, setLoading] = useState(false);

  // CRM half — fetched separately so the slow CRM view can never delay the
  // media numbers (the same split the SEO tab uses for the same reason).
  const [crm, setCrm] = useState<CampaignLeadsData | null>(null);
  const [crmLoading, setCrmLoading] = useState(true);

  // ── Account picker (⚙) ─────────────────────────────────────────────────────
  const initialSel = useMemo<Record<PaidPlatform, string[]>>(
    () => ({
      google: config.accounts.google.map((a) => a.id),
      meta: config.accounts.meta.map((a) => a.id),
      linkedin: config.accounts.linkedin.map((a) => a.id),
    }),
    [config],
  );
  // With no server-side data the "should the picker auto-open" signal comes
  // from the config itself: zero selected accounts means there is nothing to
  // load until the user picks some.
  const nothingSelected = PLATFORM_ORDER.every((p) => (config.accounts[p] ?? []).length === 0);
  const [cfgOpen, setCfgOpen] = useState(initial ? initial.unconfigured : nothingSelected);
  const [sel, setSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [savedSel, setSavedSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [showHidden, setShowHidden] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const selKey = (s: Record<PaidPlatform, string[]>) => PLATFORM_ORDER.map((p) => [...s[p]].sort().join(",")).join("|");
  const dirty = selKey(sel) !== selKey(savedSel);

  // ── View filters ────────────────────────────────────────────────────────────
  const [platformFilter, setPlatformFilter] = useState<"all" | PaidPlatform>("all");
  const [goalFilter, setGoalFilter] = useState<"all" | CampaignGoal>("all");
  const [utmSrc, setUtmSrc] = useState<string>("all");
  const [utmMed, setUtmMed] = useState<string>("all");
  const [q, setQ] = useState("");

  const rangeQs = useCallback(
    () => (mode === "custom" && from && to && from <= to ? `from=${from}&to=${to}` : `days=${days}`),
    [mode, from, to, days],
  );

  const loadMedia = useCallback(async (qs: string, lvl: PaidLevel) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/digital?${qs}&level=${lvl}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) setData(json as PaidData);
      else console.error("[digital] refresh failed", json?.error ?? res.status);
    } catch (e) {
      console.error("[digital] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCrm = useCallback(async (qs: string) => {
    setCrmLoading(true);
    try {
      const res = await fetch(`/api/digital/crm?${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) setCrm(json as CampaignLeadsData);
      else setCrm({ connected: true, label: "", rows: [], truncated: false, error: json?.error || `HTTP ${res.status}` });
    } catch (e) {
      setCrm({ connected: true, label: "", rows: [], truncated: false, error: String(e) });
    } finally {
      setCrmLoading(false);
    }
  }, []);

  // Both halves load on mount ON PURPOSE — media because the server no longer
  // blocks navigation on Supermetrics, CRM because the Metabase view is slow.
  // Flipping loading flags during the mount effect is the intended behaviour
  // here, not a cascading render. Level changes refetch media only; the CRM
  // join key is the campaign either way.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!initial) loadMedia(rangeQs(), "campaign");
    loadCrm(rangeQs());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickPreset(d: number) {
    setMode("preset");
    setDays(d);
    loadMedia(`days=${d}`, level);
    loadCrm(`days=${d}`);
  }
  function applyCustom() {
    if (!from || !to || from > to) return;
    setMode("custom");
    loadMedia(`from=${from}&to=${to}`, level);
    loadCrm(`from=${from}&to=${to}`);
  }
  function changeLevel(lvl: PaidLevel) {
    if (lvl === level) return;
    setLevel(lvl);
    loadMedia(rangeQs(), lvl);
  }

  // ── Account picker actions ──────────────────────────────────────────────────
  function toggleAccount(p: PaidPlatform, id: string) {
    setCfgMsg(null);
    setSel((s) => ({ ...s, [p]: s[p].includes(id) ? s[p].filter((x) => x !== id) : [...s[p], id] }));
  }
  function setPlatformAll(p: PaidPlatform, on: boolean, visible: CatalogAccount[]) {
    setCfgMsg(null);
    setSel((s) => ({ ...s, [p]: on ? [...new Set([...s[p], ...visible.map((a) => a.id)])] : s[p].filter((id) => !visible.some((a) => a.id === id)) }));
  }
  function closeConfig(revert: boolean) {
    if (revert) setSel(savedSel);
    setCfgMsg(null);
    setCfgOpen(false);
  }
  function saveAndClose() {
    setCfgMsg(null);
    startSave(async () => {
      const payload: Record<string, { id: string; name: string }[]> = {};
      for (const p of PLATFORM_ORDER) {
        payload[p] = sel[p].map((id) => ({ id, name: ACCOUNT_CATALOG[p].find((a) => a.id === id)?.name || id }));
      }
      const r = await savePaidConfigAction(payload);
      if (!r.ok) {
        setCfgMsg(r.error || "Could not save.");
        return;
      }
      setSavedSel(sel);
      setCfgMsg(null);
      setCfgOpen(false);
      await loadMedia(rangeQs(), level);
    });
  }

  // ── Media side, filtered ────────────────────────────────────────────────────
  const mediaRows = useMemo(() => {
    const needle = norm(q);
    return (data?.rows ?? []).filter(
      (r) =>
        (platformFilter === "all" || r.platform === platformFilter) &&
        (goalFilter === "all" || r.goal === goalFilter) &&
        (!needle ||
          norm(r.campaign).includes(needle) ||
          norm(r.adset ?? "").includes(needle) ||
          norm(r.ad ?? "").includes(needle) ||
          norm(r.accountName).includes(needle)),
    );
  }, [data?.rows, platformFilter, goalFilter, q]);

  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    let impressions = 0, clicks = 0, result = 0;
    for (const r of mediaRows) {
      byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + r.cost);
      impressions += r.impressions;
      clicks += r.clicks;
      result += r.result;
    }
    const curs = [...byCur.entries()].sort((a, b) => b[1] - a[1]);
    return {
      spendByCurrency: curs,
      singleCurrency: curs.length === 1 ? curs[0][0] : null,
      spend: curs.reduce((s, [, v]) => s + v, 0),
      impressions, clicks, result,
    };
  }, [mediaRows]);

  // ── CRM side, filtered ──────────────────────────────────────────────────────
  /**
   * The platform filter narrows the CRM side by utm_source spelling; the UTM
   * chips narrow it directly; the search box matches utm_campaign so both
   * tables answer the same question at once.
   */
  const crmFiltered = useMemo(() => {
    const rows = crm?.rows ?? [];
    const needle = norm(q);
    const srcSet = platformFilter === "all" ? null : new Set(SRC_OF_PLATFORM[platformFilter]);
    return rows.filter(
      (r) =>
        (!srcSet || srcSet.has(norm(r.source))) &&
        (utmSrc === "all" || norm(r.source) === utmSrc) &&
        (utmMed === "all" || norm(r.medium) === utmMed) &&
        (!needle || norm(r.campaign).includes(needle)),
    );
  }, [crm, platformFilter, utmSrc, utmMed, q]);

  const crmAgg = useMemo(() => {
    let total = 0, qualified = 0, deals = 0;
    const byStage = new Map<string, number>();
    for (const r of crmFiltered) {
      total += r.n;
      byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + r.n);
      if (stageIdx(r.stage) >= 1) qualified += r.n;
      if (r.stage.toLowerCase() === "deal") deals += r.n;
    }
    const stages = STAGE_ORDER.filter((s) => byStage.has(s)).map((s) => ({ stage: s, n: byStage.get(s)! }));
    // Anything outside the known vocabulary still counts — appended, not dropped.
    for (const [s, n] of byStage) if (!STAGE_ORDER.some((x) => x === s)) stages.push({ stage: s, n });
    return { total, qualified, deals, stages };
  }, [crmFiltered]);

  const crmByCampaign = useMemo(() => {
    const m = new Map<string, CrmJoin>();
    for (const r of crmFiltered) {
      const k = norm(r.campaign);
      const cur = m.get(k) ?? { leads: 0, qualified: 0, deals: 0 };
      cur.leads += r.n;
      if (stageIdx(r.stage) >= 1) cur.qualified += r.n;
      if (r.stage.toLowerCase() === "deal") cur.deals += r.n;
      m.set(k, cur);
    }
    return m;
  }, [crmFiltered]);

  /** Join: campaign name (case-insensitive) or the Meta campaign id. */
  const joinFor = useCallback(
    (r: CampaignRow): CrmJoin | null => {
      const byName = crmByCampaign.get(norm(r.campaign));
      if (byName) return byName;
      if (r.campaignId) return crmByCampaign.get(norm(r.campaignId)) ?? null;
      return null;
    },
    [crmByCampaign],
  );

  /** CRM campaigns that matched nothing on the media side — the tagging gaps. */
  const unmatchedCrm = useMemo(() => {
    const mediaKeys = new Set<string>();
    for (const r of data?.rows ?? []) {
      mediaKeys.add(norm(r.campaign));
      if (r.campaignId) mediaKeys.add(norm(r.campaignId));
    }
    const acc = new Map<string, { campaign: string; source: string; leads: number }>();
    for (const r of crmFiltered) {
      const k = norm(r.campaign);
      if (mediaKeys.has(k) || r.campaign === "(none)") continue;
      const cur = acc.get(k) ?? { campaign: r.campaign, source: r.source, leads: 0 };
      cur.leads += r.n;
      acc.set(k, cur);
    }
    return [...acc.values()].sort((a, b) => b.leads - a.leads).slice(0, 10);
  }, [crmFiltered, data?.rows]);

  const utmSources = useMemo(() => {
    const acc = new Map<string, number>();
    for (const r of crm?.rows ?? []) acc.set(norm(r.source), (acc.get(norm(r.source)) ?? 0) + r.n);
    return [...acc].sort((a, b) => b[1] - a[1]);
  }, [crm]);
  const utmMediums = useMemo(() => {
    const acc = new Map<string, number>();
    for (const r of crm?.rows ?? []) acc.set(norm(r.medium), (acc.get(norm(r.medium)) ?? 0) + r.n);
    return [...acc].sort((a, b) => b[1] - a[1]);
  }, [crm]);

  // ── Full funnel: media → CRM ───────────────────────────────────────────────
  const funnel = useMemo(() => {
    const steps = [
      { label: "Impressions", n: totals.impressions, note: "ads shown" },
      { label: "Clicks", n: totals.clicks, note: "visits bought" },
      { label: "CRM leads", n: crmAgg.total, note: "utm-tagged enquiries" },
      { label: "Qualified+", n: crmAgg.qualified, note: "past the New stage" },
      { label: "Deal stage", n: crmAgg.deals, note: "current pipeline" },
    ];
    return steps;
  }, [totals, crmAgg]);

  const cur = totals.singleCurrency ?? "—";
  const cpl = crmAgg.total > 0 && totals.singleCurrency ? totals.spend / crmAgg.total : null;
  const cpql = crmAgg.qualified > 0 && totals.singleCurrency ? totals.spend / crmAgg.qualified : null;
  const selectedCount = PLATFORM_ORDER.reduce((n, p) => n + sel[p].length, 0);
  const goalsPresent = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.goal))], [data?.rows]);
  const platformsPresent = useMemo(() => PLATFORM_ORDER.filter((p) => (data?.rows ?? []).some((r) => r.platform === p)), [data?.rows]);

  const byGoal = useMemo(() => {
    const acc = new Map<CampaignGoal, number>();
    for (const r of mediaRows) acc.set(r.goal, (acc.get(r.goal) ?? 0) + r.cost);
    return [...acc].map(([goal, cost]) => ({ goal, cost })).sort((a, b) => b.cost - a.cost);
  }, [mediaRows]);

  const byPlatform = useMemo(() => {
    const acc = new Map<PaidPlatform, { cost: number; impressions: number; clicks: number; result: number; n: number; currencies: Set<string> }>();
    for (const r of mediaRows) {
      const cur = acc.get(r.platform) ?? { cost: 0, impressions: 0, clicks: 0, result: 0, n: 0, currencies: new Set<string>() };
      cur.cost += r.cost; cur.impressions += r.impressions; cur.clicks += r.clicks; cur.result += r.result; cur.n += 1;
      cur.currencies.add(r.currency);
      acc.set(r.platform, cur);
    }
    return PLATFORM_ORDER.filter((p) => acc.has(p)).map((p) => ({ platform: p, ...acc.get(p)! }));
  }, [mediaRows]);

  const rowName = (r: CampaignRow) => (level === "ad" ? r.ad ?? r.adset ?? r.campaign : level === "adset" ? r.adset ?? r.campaign : r.campaign);
  const rowContext = (r: CampaignRow) =>
    level === "ad" ? [r.campaign, r.adset].filter(Boolean).join(" › ") : level === "adset" ? r.campaign : null;

  const funnelMax = Math.max(...funnel.map((s) => s.n), 1);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Digital Performance</h1>
          <p className="page-sub">
            Paid media · Google, Meta &amp; LinkedIn via Supermetrics · CRM funnel via Metabase · {data ? data.label : "loading…"}
            {data && loading ? " · refreshing…" : ""}
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
          <div className="chart-sub">Pick the accounts that represent live activity. Closed, disabled and messaging-integration accounts are hidden by default.</div>
          <div style={{ display: "flex", gap: 6, margin: "10px 0", alignItems: "center", flexWrap: "wrap" }}>
            <button className="filter-btn" onClick={saveAndClose} disabled={saving}>{saving ? "Saving…" : "Save & close"}</button>
            <button className="filter-btn" onClick={() => closeConfig(true)} disabled={saving}>{dirty ? "Discard changes" : "Close"}</button>
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
                    <button className="filter-btn" style={{ fontSize: 10, padding: "1px 7px", marginLeft: "auto" }} onClick={() => setPlatformAll(p, !allOn, visible)}>
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

      {!data ? (
        nothingSelected && !loading ? (
          <div className="chart-card">
            <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
              <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>No accounts selected yet</div>
              <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.7, maxWidth: 520, margin: "0 auto" }}>
                Open <strong>⚙</strong> above and tick the ad accounts you want on this dashboard.
              </div>
            </div>
          </div>
        ) : (
          <DigitalSkeleton />
        )
      ) : !data.connected ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>Supermetrics not connected</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.8 }}>
              Add to the deployment environment, then refresh:
              <br />
              {["SUPERMETRICS_API_KEY", "SUPERMETRICS_DS_USER_GOOGLE", "SUPERMETRICS_DS_USER_META", "SUPERMETRICS_DS_USER_LINKEDIN"].map((l) => (
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
              Open <strong>⚙</strong> above and tick the ad accounts you want on this dashboard.
            </div>
          </div>
        </div>
      ) : (
        <>
          {data.error && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="empty-state" style={{ height: "auto", padding: "18px 16px", display: "block" }}>⚠ {data.error}</div>
            </div>
          )}

          {/* ── KPIs: spend → outcome, left to right ─────────────────────────── */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">Spend <HelpTip text={totals.singleCurrency ? `Media spend across the filtered rows, in ${totals.singleCurrency}.` : "The filtered accounts bill in more than one currency; the split is shown below and nothing is summed across currencies."} /></div>
              <div className="kpi-value">{totals.singleCurrency ? money(totals.spend, cur) : <span style={{ fontSize: 15 }}>Mixed currency</span>}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Impressions <HelpTip text="Ads shown, across the filtered rows." /></div>
              <div className="kpi-value">{fmtK(totals.impressions)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Clicks <HelpTip text="Google and LinkedIn report all clicks; Meta reports link clicks." /></div>
              <div className="kpi-value">{fmtK(totals.clicks)} <span className="muted" style={{ fontSize: 12 }}>· CTR {pct1(ratio(totals.clicks, totals.impressions))}</span></div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">CRM leads <HelpTip text="Leads created in the CRM in this range whose record carries a utm_campaign — the ones attributable to a campaign. Filtered by the same platform/UTM filters as everything else. Source: Metabase." /></div>
              <div className="kpi-value" style={{ color: C.green }}>{crmLoading ? "…" : crm?.error ? "—" : fmt(crmAgg.total)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Cost / CRM lead <HelpTip text={totals.singleCurrency ? "Filtered spend divided by CRM leads. Also shown per qualified lead — leads past the New stage." : "Hidden while the filtered accounts span multiple currencies — dividing a mixed sum would be meaningless."} /></div>
              <div className="kpi-value" style={{ fontSize: 16 }}>
                {cpl == null ? "—" : money(cpl, cur)}
                {cpql != null && <span className="muted" style={{ fontSize: 12 }}> · {money(cpql, cur)} / qualified</span>}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Reached Deal stage <HelpTip text="Campaign-tagged leads currently sitting at the Deal stage of the CRM pipeline. A stage snapshot — not the same as a signed transaction in the deals table." /></div>
              <div className="kpi-value">{crmLoading ? "…" : crm?.error ? "—" : fmt(crmAgg.deals)}</div>
            </div>
          </div>

          {totals.spendByCurrency.length > 1 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="chart-title">Spend by currency</div>
              <div className="chart-sub">These are not added together — no conversion rate is applied anywhere on this tab.</div>
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

          {/* ── The proof: media → CRM funnel ────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div className="chart-title">
              Paid funnel — spend to pipeline <HelpTip text="Media numbers from the ad platforms; lead, qualification and deal numbers from the CRM, joined on utm_campaign. Stages are where each lead sits today (a snapshot), not cohort progression. Percentages are of the previous step." />
            </div>
            <div className="chart-sub">
              {crmLoading ? "CRM loading…" : crm?.error ? `CRM unavailable: ${crm.error}` : `Impressions and clicks from ${data.accountsUsed.length} account(s) · leads from campaign-tagged CRM records · ${data.label}`}
            </div>
            <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
              {funnel.map((s, i) => {
                const prev = i > 0 ? funnel[i - 1].n : null;
                const conv = prev != null && prev > 0 ? s.n / prev : null;
                const isCrm = i >= 2;
                return (
                  <div key={s.label} style={{ display: "grid", gridTemplateColumns: "150px 1fr 170px", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: isCrm ? C.green : C.dark }}>
                      {s.label}
                      <div className="muted" style={{ fontSize: 10, fontWeight: 400 }}>{s.note}</div>
                    </div>
                    <div style={{ background: "var(--warm-white)", borderRadius: 5, height: 26, position: "relative", overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${Math.max((s.n / funnelMax) * 100, s.n > 0 ? 1.5 : 0)}%`,
                          background: isCrm ? C.green : C.blue,
                          opacity: isCrm ? 0.85 : 0.75,
                          height: "100%",
                          borderRadius: 5,
                          transition: "width .3s",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 12, textAlign: "right" }}>
                      <strong>{fmtK(s.n)}</strong>
                      {conv != null && <span className="muted"> · {pct0(conv)} of prev.</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Trend + platform mix ─────────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Spend &amp; results over time</div>
              <div className="chart-sub">Daily · all selected accounts · {data.label}</div>
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
              <div className="chart-title">Where the money goes</div>
              <div className="chart-sub">
                {totals.singleCurrency ? `Spend share by platform (${cur})` : "Impression share by platform — spend spans multiple currencies, so shares use impressions"} · then by campaign goal
              </div>
              <div className="chart-canvas-wrap" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {byPlatform.length ? (
                  <>
                    <ChartBox
                      type="doughnut"
                      data={{
                        labels: byPlatform.map((p) => PLATFORMS[p.platform].label),
                        datasets: [{
                          data: byPlatform.map((p) => (totals.singleCurrency ? p.cost : p.impressions)),
                          backgroundColor: byPlatform.map((p) => PLATFORM_COLOR[p.platform]),
                          borderWidth: 1,
                        }],
                      }}
                      options={{ plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } } }, cutout: "55%" }}
                    />
                    <ChartBox
                      type="bar"
                      data={{
                        labels: byGoal.map((g) => GOAL_LABELS[g.goal]),
                        datasets: [{ label: "Spend", data: byGoal.map((g) => g.cost), backgroundColor: byGoal.map((g) => GOAL_COLOR[g.goal]), borderRadius: 5 }],
                      }}
                      options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }}
                    />
                  </>
                ) : (
                  <div className="empty-state" style={{ gridColumn: "1 / -1" }}>No campaigns match the filters.</div>
                )}
              </div>
            </div>
          </div>

          {/* ── CRM pipeline of the filtered leads ───────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">
                CRM pipeline — campaign-tagged leads <HelpTip text="Where the leads matching the current filters sit in the pipeline right now. Same stage vocabulary as the SEO tab. Source: Metabase." />
              </div>
              <div className="chart-sub">{crmLoading ? "loading…" : `${fmt(crmAgg.total)} leads · ${crm?.label ?? ""}${crm?.truncated ? " · largest groups only (row cap hit)" : ""}`}</div>
              <div className="chart-canvas-wrap">
                {crm?.error ? (
                  <div className="empty-state">⚠ {crm.error}</div>
                ) : crmAgg.stages.length ? (
                  <ChartBox
                    type="bar"
                    data={{
                      labels: crmAgg.stages.map((s) => s.stage),
                      datasets: [{ label: "Leads", data: crmAgg.stages.map((s) => s.n), backgroundColor: crmAgg.stages.map((s) => (s.stage === "Deal" ? C.green : s.stage === "New" ? C.sand : C.blue)), borderRadius: 5 }],
                    }}
                    options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }}
                  />
                ) : (
                  <div className="empty-state">{crmLoading ? "Loading from the CRM…" : "No campaign-tagged leads match the filters."}</div>
                )}
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">
                Platform comparison <HelpTip text="Rates are derived from raw totals, never averaged from the platforms' own pre-aggregated rate fields." />
              </div>
              <div className="chart-sub">Totals per platform for the current filters</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th>Platform</th><th style={{ textAlign: "right" }}>Spend</th><th style={{ textAlign: "right" }}>Impr.</th>
                      <th style={{ textAlign: "right" }}>Clicks</th><th style={{ textAlign: "right" }}>CTR</th><th style={{ textAlign: "right" }}>Results</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byPlatform.map((p) => {
                      const pc = p.currencies.size === 1 ? [...p.currencies][0] : "—";
                      return (
                        <tr key={p.platform}>
                          <td><span style={{ color: PLATFORM_COLOR[p.platform], fontWeight: 600 }}>{PLATFORMS[p.platform].label}</span></td>
                          <td style={{ textAlign: "right" }}>{money(p.cost, pc)}</td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.impressions)}</td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.clicks)}</td>
                          <td style={{ textAlign: "right" }}>{pct1(ratio(p.clicks, p.impressions))}</td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p.result)}</td>
                        </tr>
                      );
                    })}
                    {!byPlatform.length && <tr><td colSpan={6} className="muted">No rows match the filters.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Explorer: campaign / ad set / ad, with CRM columns ───────────── */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title">
              Explorer <HelpTip text="Every row with spend in range, biggest first. Result is goal-aware — leads for lead campaigns, link clicks for traffic, website conversions for sales. CRM columns join by utm_campaign (name or Meta campaign id) at campaign level; ad sets and ads inherit no CRM figures because the CRM only records the campaign tag." />
            </div>
            <div className="chart-sub">
              {mediaRows.length} row{mediaRows.length === 1 ? "" : "s"} · {LEVEL_LABEL[level].toLowerCase()}
              {data.truncated ? " · some accounts hit the row cap — totals may undercount" : ""}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 4px", alignItems: "center" }}>
              {(Object.keys(LEVEL_LABEL) as PaidLevel[]).map((l) => (
                <button key={l} className={`filter-btn${level === l ? " active" : ""}`} onClick={() => changeLevel(l)}>{LEVEL_LABEL[l]}</button>
              ))}
              <span style={{ width: 10 }} />
              <button className={`filter-btn${platformFilter === "all" ? " active" : ""}`} onClick={() => setPlatformFilter("all")}>All platforms</button>
              {platformsPresent.map((p) => (
                <button key={p} className={`filter-btn${platformFilter === p ? " active" : ""}`} onClick={() => setPlatformFilter(p)}>{PLATFORMS[p].label}</button>
              ))}
              <span style={{ width: 10 }} />
              <button className={`filter-btn${goalFilter === "all" ? " active" : ""}`} onClick={() => setGoalFilter("all")}>All goals</button>
              {goalsPresent.map((g) => (
                <button key={g} className={`filter-btn${goalFilter === g ? " active" : ""}`} onClick={() => setGoalFilter(g)}>{GOAL_LABELS[g]}</button>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0 10px", alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 11 }}>UTM <HelpTip text="Filters both the CRM figures and the funnel by the utm_source / utm_medium recorded on each lead. The platform filter also narrows the CRM side by the usual spellings of each platform's source tag." /></span>
              <select className="search-box" style={{ width: 170 }} value={utmSrc} onChange={(e) => setUtmSrc(e.target.value)}>
                <option value="all">source: all</option>
                {utmSources.map(([s, n]) => (
                  <option key={s} value={s}>{s} ({n})</option>
                ))}
              </select>
              <select className="search-box" style={{ width: 170 }} value={utmMed} onChange={(e) => setUtmMed(e.target.value)}>
                <option value="all">medium: all</option>
                {utmMediums.map(([m, n]) => (
                  <option key={m} value={m}>{m} ({n})</option>
                ))}
              </select>
              <input className="search-box" style={{ flex: 1, minWidth: 180 }} placeholder="Search campaigns, ad sets, ads…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>{LEVEL_LABEL[level].replace(/s$/, "")}</th><th>Account</th><th>Goal</th>
                    <th style={{ textAlign: "right" }}>Spend</th>
                    <th style={{ textAlign: "right" }}>Impr.</th>
                    <th style={{ textAlign: "right" }}>Clicks</th>
                    <th style={{ textAlign: "right" }}>CTR</th>
                    <th style={{ textAlign: "right" }}>Result</th>
                    <th>Measured as</th>
                    {level === "campaign" && (
                      <>
                        <th style={{ textAlign: "right" }}>CRM leads</th>
                        <th style={{ textAlign: "right" }}>Qualified+</th>
                        <th style={{ textAlign: "right" }}>Deals</th>
                        <th style={{ textAlign: "right" }}>Cost / lead</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {mediaRows.slice(0, 80).map((r) => {
                    const j = level === "campaign" ? joinFor(r) : null;
                    const ctx = rowContext(r);
                    const shallow = r.granularity !== level && level !== "campaign";
                    return (
                      <tr key={`${r.platform}|${r.accountId}|${r.campaign}|${r.adset ?? ""}|${r.ad ?? ""}`}>
                        <td title={r.objective || undefined}>
                          {rowName(r)}
                          {ctx && <div className="muted" style={{ fontSize: 10 }}>{ctx}</div>}
                          {shallow && (
                            <div className="muted" style={{ fontSize: 10 }} title={r.platform === "google" ? "Google responsive search ads have no single ad name; shown at ad-group level." : "LinkedIn creative naming is unreliable; shown at campaign level."}>
                              ({r.granularity === "adset" ? "ad-group level" : "campaign level"})
                            </div>
                          )}
                        </td>
                        <td className="muted" style={{ fontSize: 11 }}><span style={{ color: PLATFORM_COLOR[r.platform] }}>●</span> {r.accountName}</td>
                        <td><span style={{ color: GOAL_COLOR[r.goal], fontWeight: 600, fontSize: 11 }}>{GOAL_LABELS[r.goal]}</span></td>
                        <td style={{ textAlign: "right" }}>{money(r.cost, r.currency)}</td>
                        <td style={{ textAlign: "right" }}>{fmtK(r.impressions)}</td>
                        <td style={{ textAlign: "right" }}>{fmtK(r.clicks)}</td>
                        <td style={{ textAlign: "right" }}>{pct1(ratio(r.clicks, r.impressions))}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(r.result)}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{r.resultLabel}</td>
                        {level === "campaign" && (
                          <>
                            <td style={{ textAlign: "right", fontWeight: 600, color: j ? C.green : undefined }}>{j ? fmt(j.leads) : "—"}</td>
                            <td style={{ textAlign: "right" }}>{j ? fmt(j.qualified) : "—"}</td>
                            <td style={{ textAlign: "right" }}>{j ? fmt(j.deals) : "—"}</td>
                            <td style={{ textAlign: "right" }}>{j && j.leads > 0 ? money(r.cost / j.leads, r.currency) : "—"}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                  {!mediaRows.length && <tr><td colSpan={level === "campaign" ? 13 : 9} className="muted">No rows match the filters.</td></tr>}
                </tbody>
              </table>
            </div>
            {mediaRows.length > 80 && <div className="chart-sub" style={{ marginTop: 8 }}>Showing the 80 highest-spending of {mediaRows.length} rows — narrow with the filters or search.</div>}
            {level === "campaign" && !crmLoading && !crm?.error && (
              <div className="chart-sub" style={{ marginTop: 8 }}>
                A dash in the CRM columns means no lead in range carries that campaign&apos;s name or id as its utm_campaign — either it drives no form fills, or its ads aren&apos;t tagged.
              </div>
            )}
          </div>

          {/* ── Meta outcome breakdown ──────────────────────────────────────── */}
          {mediaRows.some((r) => r.platform === "meta") && (
            <div className="chart-card" style={{ marginTop: 4 }}>
              <div className="chart-title">
                Meta — all outcomes side by side <HelpTip text="Meta reports several outcomes for the same row at once, and which one matters depends on the objective. All four are shown so a campaign is never judged on a metric it was not buying." />
              </div>
              <div className="chart-sub">Link clicks, website conversions, website leads and on-Facebook form leads</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th>{LEVEL_LABEL[level].replace(/s$/, "")}</th><th>Objective</th>
                      <th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Link clicks</th>
                      <th style={{ textAlign: "right" }}>Website conv.</th>
                      <th style={{ textAlign: "right" }}>Website leads</th>
                      <th style={{ textAlign: "right" }}>On-FB leads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mediaRows.filter((r) => r.platform === "meta").slice(0, 40).map((r) => (
                      <tr key={`m|${r.accountId}|${r.campaign}|${r.adset ?? ""}|${r.ad ?? ""}`}>
                        <td>
                          {rowName(r)}
                          {rowContext(r) && <div className="muted" style={{ fontSize: 10 }}>{rowContext(r)}</div>}
                        </td>
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

          {/* ── UTM tagging gaps ─────────────────────────────────────────────── */}
          {unmatchedCrm.length > 0 && (
            <div className="chart-card" style={{ marginTop: 4 }}>
              <div className="chart-title">
                CRM campaigns with no matching ad campaign <HelpTip text="utm_campaign values on CRM leads that match no campaign name or id on the selected ad accounts. Either the campaign lives on an unselected/unlicensed account, it's a non-paid source using campaign tags (email, portals), or the ads and the CRM disagree on naming — tagging debt worth cleaning either way." />
              </div>
              <div className="chart-sub">Top {unmatchedCrm.length} by leads · these leads are in the funnel above but join to no row in the explorer</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead><tr><th>utm_campaign</th><th>utm_source</th><th style={{ textAlign: "right" }}>Leads</th></tr></thead>
                  <tbody>
                    {unmatchedCrm.map((u) => (
                      <tr key={u.campaign}>
                        <td>{u.campaign}</td>
                        <td className="muted">{u.source}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(u.leads)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Accounts that could not be read ─────────────────────────────── */}
          {data.failures.length > 0 && (
            <div className="chart-card" style={{ marginTop: 4 }}>
              <div className="chart-title">
                Accounts that could not be read ({data.failures.length}) <HelpTip text="Selected accounts that returned no data and why. Listed rather than silently omitted, because a missing account looks identical to a quiet one on the numbers above. Hover a reason for the raw response." />
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
                        <td style={{ fontSize: 11, maxWidth: 520, whiteSpace: "normal" }} title={f.raw}>{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.failures.some((f) => f.notPrioritised) && (
                <div className="chart-sub" style={{ marginTop: 10 }}>
                  Supermetrics licenses a subset of ad accounts for querying. Change the prioritised list on the{" "}
                  <a href="https://hub.supermetrics.com/token-management" target="_blank" rel="noopener noreferrer">Supermetrics hub</a> and these will start loading.
                </div>
              )}
              {data.failures.some((f) => f.authProblem) && (
                <div className="chart-sub" style={{ marginTop: 10 }}>
                  <strong>Configuration, not missing data:</strong> each platform needs the Supermetrics login that authorised it —
                  {[...new Set(data.failures.filter((f) => f.authProblem).map((f) => f.platform))].map((p) => (
                    <div key={p} style={{ marginTop: 4 }}>
                      <code style={{ background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>{PLATFORMS[p].dsUserEnv}</code> → {PLATFORMS[p].dsUserHint}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="chart-sub" style={{ marginTop: 14 }}>
            Sources: {data.accountsUsed.length} ad account{data.accountsUsed.length === 1 ? "" : "s"} with data via Supermetrics
            {data.emptyAccounts.length ? ` · ${data.emptyAccounts.length} read but quiet in range (${data.emptyAccounts.map((a) => a.name).join(", ")})` : ""}
            {data.failures.length ? ` · ${data.failures.length} unavailable` : ""}
            {" "}· CRM funnel from Metabase, joined on utm_campaign · rates derived from raw totals, never from pre-aggregated rate fields.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Placeholder mirroring the real layout — KPI strip, funnel, charts, table — so
 * the page keeps its shape while Supermetrics answers (up to ~25s per account).
 */
function DigitalSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading paid media data…">
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="skeleton sk-line short" />
            <div className="skeleton sk-big" />
          </div>
        ))}
      </div>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="skeleton sk-line" style={{ width: "30%" }} />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr 170px", alignItems: "center", gap: 10, margin: "10px 0" }}>
            <div className="skeleton sk-line" style={{ margin: 0 }} />
            <div className="skeleton" style={{ height: 26, width: `${90 - i * 18}%` }} />
            <div className="skeleton sk-line short" style={{ margin: 0, justifySelf: "end" }} />
          </div>
        ))}
      </div>
      <div className="charts-grid-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="chart-card">
            <div className="skeleton sk-line" style={{ width: "40%" }} />
            <div className="skeleton sk-block" />
          </div>
        ))}
      </div>
      <div className="chart-card" style={{ marginTop: 4 }}>
        <div className="skeleton sk-line" style={{ width: "25%" }} />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton sk-line" style={{ width: `${95 - i * 6}%` }} />
        ))}
      </div>
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
          <span style={{ fontSize: 10, color: C.coral }} title="Verified: Supermetrics rejects this account as not prioritised on the subscription">
            {" "}· not licensed
          </span>
        )}
      </span>
    </label>
  );
}
