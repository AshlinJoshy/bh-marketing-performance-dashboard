"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker, { rangeFor } from "@/components/DateRangePicker";
import { savePaidConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import { PLATFORMS, GOAL_LABELS, type PaidData, type PaidPlatform, type CampaignGoal, type PaidLevel, type CampaignRow } from "@/lib/paid";
import { ACCOUNT_CATALOG, VERIFIED_BLOCKED, SUPERMETRICS_SUBSCRIPTION_URL, type CatalogAccount } from "@/lib/paidAccounts";
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
// Google reads green and Meta blue everywhere on this tab, by request.
const PLATFORM_COLOR: Record<PaidPlatform, string> = { google: C.green, meta: C.blue, linkedin: "#7c5cbf" };
const GOAL_COLOR: Record<CampaignGoal, string> = {
  leads: C.green, conversions: C.blue, traffic: C.sand, awareness: "#7c5cbf", engagement: C.coral, other: C.mid,
};

const norm = (s: string) => s.toLowerCase().trim();
/** A lead still in play. Closed = dropped/lost, and drops out of the funnel. */
const inPlay = (state: string) => norm(state) !== "closed";

/**
 * Does a utm_source spelling belong to a platform? Matches the spellings seen
 * live in Engage — 'Facebook', 'meta-retargeting-static', 'meta-lal-static',
 * 'google' — as substrings, since the tags are free text. A heuristic, and
 * labelled as such where it's used.
 */
function srcMatches(platform: PaidPlatform, src: string): boolean {
  const s = norm(src);
  if (platform === "google") return s.includes("google") || s.includes("adwords");
  if (platform === "meta") return s.includes("facebook") || s.includes("meta") || s.includes("instagram") || s === "fb" || s === "ig";
  return s.includes("linkedin") || s === "li";
}

const LEVEL_LABEL: Record<PaidLevel, string> = { campaign: "Campaigns", adset: "Ad sets", ad: "Ads" };
const DEPTH: Record<PaidLevel, number> = { campaign: 0, adset: 1, ad: 2 };

type CrmJoin = { leads: number; qualified: number; deals: number };
type StageAgg = { leads: number; qualified: number; viewing: number; offerRes: number; deals: number };

const emptyStages = (): StageAgg => ({ leads: 0, qualified: 0, viewing: 0, offerRes: 0, deals: 0 });
function addStage(a: StageAgg, stage: string, state: string, n: number) {
  if (!inPlay(state)) return;
  a.leads += n;
  const st = norm(stage);
  if (st === "qualified") a.qualified += n;
  else if (st === "viewing") a.viewing += n;
  else if (st === "offer" || st === "reserved") a.offerRes += n;
  else if (st === "deal") a.deals += n;
}

// Default range = this month, resolved once at module load (never during render).
const INIT_RANGE = rangeFor("this_month");

// ─── Searchable filter dropdown ───────────────────────────────────────────────
function FilterSelect({
  label,
  value,
  options,
  onChange,
  width = 190,
}: {
  label: string;
  value: string; // "all" or a concrete value
  options: [string, number][];
  onChange: (v: string) => void;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const needle = norm(search);
  const shown = needle ? options.filter(([v]) => v.includes(needle)) : options;

  return (
    <div ref={boxRef} style={{ position: "relative", width }}>
      <button
        className="search-box"
        style={{ width: "100%", textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        onClick={() => { setOpen((v) => !v); setSearch(""); }}
        title={value === "all" ? `${label}: all` : `${label}: ${value}`}
      >
        {value === "all" ? `${label}: all` : `${label}: ${value.length > 24 ? value.slice(0, 24) + "…" : value}`} <span className="muted">▾</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 40, width: Math.max(width, 260), maxHeight: 300, overflowY: "auto", background: "#fff", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 18px rgba(0,0,0,.08)", padding: 6 }}>
          <input
            autoFocus
            className="search-box"
            style={{ width: "100%", marginBottom: 6 }}
            placeholder={`Search ${label}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div
            style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer", borderRadius: 5, fontWeight: value === "all" ? 700 : 400 }}
            onMouseDown={() => { onChange("all"); setOpen(false); }}
          >
            all
          </div>
          {shown.slice(0, 200).map(([v, n]) => (
            <div
              key={v}
              title={v}
              style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer", borderRadius: 5, display: "flex", gap: 8, fontWeight: value === v ? 700 : 400 }}
              onMouseDown={() => { onChange(v); setOpen(false); }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</span>
              <span className="muted">{n}</span>
            </div>
          ))}
          {!shown.length && <div className="muted" style={{ padding: "4px 8px", fontSize: 12 }}>No matches.</div>}
        </div>
      )}
    </div>
  );
}

export default function DigitalDashboard({ initial, config }: { initial: PaidData | null; config: PaidConfig }) {
  // Media is fetched ONCE per range at ad level — the deepest each platform can
  // serve — and every coarser view (campaigns, ad sets, the tree) is a client-
  // side regroup of the same rows. Switching levels is instant and free.
  const [data, setData] = useState<PaidData | null>(initial);
  const [viewLevel, setViewLevel] = useState<PaidLevel>("campaign");
  const [from, setFrom] = useState(initial?.from ?? INIT_RANGE.from);
  const [to, setTo] = useState(initial?.to ?? INIT_RANGE.to);
  const [loading, setLoading] = useState(false);

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
  const nothingSelected = PLATFORM_ORDER.every((p) => (config.accounts[p] ?? []).length === 0);
  const [cfgOpen, setCfgOpen] = useState(initial ? initial.unconfigured : nothingSelected);
  const [sel, setSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [savedSel, setSavedSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [showHidden, setShowHidden] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const selKey = (s: Record<PaidPlatform, string[]>) => PLATFORM_ORDER.map((p) => [...s[p]].sort().join(",")).join("|");
  const dirty = selKey(sel) !== selKey(savedSel);

  // ── Dashboard-level filters ─────────────────────────────────────────────────
  const [platformFilter, setPlatformFilter] = useState<"all" | PaidPlatform>("all");
  const [goalFilter, setGoalFilter] = useState<"all" | CampaignGoal>("all");
  const [code, setCode] = useState("all");
  const [utmCamp, setUtmCamp] = useState("all");
  const [utmSrc, setUtmSrc] = useState("all");
  const [utmMed, setUtmMed] = useState("all");
  const [utmContent, setUtmContent] = useState("all");
  const [q, setQ] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerQ, setExplorerQ] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadMedia = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/digital?from=${f}&to=${t}&level=ad`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) setData(json as PaidData);
      else console.error("[digital] refresh failed", json?.error ?? res.status);
    } catch (e) {
      console.error("[digital] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCrm = useCallback(async (f: string, t: string) => {
    setCrmLoading(true);
    try {
      const res = await fetch(`/api/digital/crm?from=${f}&to=${t}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) setCrm(json as CampaignLeadsData);
      else setCrm({ connected: true, label: "", rows: [], codeRows: [], truncated: false, error: json?.error || `HTTP ${res.status}` });
    } catch (e) {
      setCrm({ connected: true, label: "", rows: [], codeRows: [], truncated: false, error: String(e) });
    } finally {
      setCrmLoading(false);
    }
  }, []);

  // Both halves load on mount ON PURPOSE — media because the server no longer
  // blocks navigation on Supermetrics, CRM because the Metabase view is slow.
  // Flipping loading flags during the mount effect is intended, not a cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMedia(from, to);
    loadCrm(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
    loadMedia(f, t);
    loadCrm(f, t);
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
      await loadMedia(from, to);
    });
  }

  // ── Media regrouping (ad-level rows → any view level) ──────────────────────
  const regroup = useCallback((rows: CampaignRow[], level: PaidLevel): CampaignRow[] => {
    const acc = new Map<string, CampaignRow>();
    const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    for (const r of rows) {
      const wantAdset = DEPTH[level] >= 1 && r.adset != null;
      const wantAd = DEPTH[level] >= 2 && r.ad != null;
      const key = `${r.platform}|${r.accountId}|${r.campaign}|${wantAdset ? r.adset : ""}|${wantAd ? r.ad : ""}`;
      const prev = acc.get(key);
      if (!prev) {
        acc.set(key, {
          ...r,
          adset: wantAdset ? r.adset : null,
          ad: wantAd ? r.ad : null,
          granularity: wantAd ? "ad" : wantAdset ? "adset" : "campaign",
        });
        continue;
      }
      prev.impressions += r.impressions;
      prev.clicks += r.clicks;
      prev.cost += r.cost;
      prev.result += r.result;
      prev.linkClicks = add(prev.linkClicks, r.linkClicks);
      prev.websiteConversions = add(prev.websiteConversions, r.websiteConversions);
      prev.websiteLeads = add(prev.websiteLeads, r.websiteLeads);
      prev.facebookLeads = add(prev.facebookLeads, r.facebookLeads);
      prev.conversions = add(prev.conversions, r.conversions);
    }
    return [...acc.values()].sort((a, b) => b.cost - a.cost);
  }, []);

  const mediaFiltered = useMemo(() => {
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

  const mediaRows = useMemo(() => regroup(mediaFiltered, viewLevel), [mediaFiltered, viewLevel, regroup]);

  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    let impressions = 0, clicks = 0;
    // Totals from campaign-level regroup so nothing depends on the view level.
    for (const r of regroup(mediaFiltered, "campaign")) {
      byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + r.cost);
      impressions += r.impressions;
      clicks += r.clicks;
    }
    const curs = [...byCur.entries()].sort((a, b) => b[1] - a[1]);
    return {
      spendByCurrency: curs,
      singleCurrency: curs.length === 1 ? curs[0][0] : null,
      spend: curs.reduce((s, [, v]) => s + v, 0),
      impressions, clicks,
    };
  }, [mediaFiltered, regroup]);

  // ── CRM facets: five interlinked, searchable filters ───────────────────────
  /** utm_campaigns that live under the selected campaign_code (from Engage). */
  const campaignsUnderCode = useMemo(() => {
    if (code === "all") return null;
    const set = new Set<string>();
    for (const r of crm?.codeRows ?? []) if (norm(r.code) === code) set.add(norm(r.campaign));
    return set;
  }, [crm?.codeRows, code]);

  const crmBase = useCallback(
    (skip: "campaign" | "source" | "medium" | "content" | null) => {
      const rows = crm?.rows ?? [];
      const needle = norm(q);
      return rows.filter(
        (r) =>
          (platformFilter === "all" || srcMatches(platformFilter, r.source)) &&
          (!campaignsUnderCode || campaignsUnderCode.has(norm(r.campaign))) &&
          (skip === "campaign" || utmCamp === "all" || norm(r.campaign) === utmCamp) &&
          (skip === "source" || utmSrc === "all" || norm(r.source) === utmSrc) &&
          (skip === "medium" || utmMed === "all" || norm(r.medium) === utmMed) &&
          (skip === "content" || utmContent === "all" || norm(r.content) === utmContent) &&
          (!needle || norm(r.campaign).includes(needle)),
      );
    },
    [crm?.rows, platformFilter, campaignsUnderCode, utmCamp, utmSrc, utmMed, utmContent, q],
  );

  const facetOf = (rows: { campaign: string; source: string; medium: string; content: string; n: number }[], key: "campaign" | "source" | "medium" | "content") => {
    const acc = new Map<string, number>();
    for (const r of rows) {
      const v = norm(r[key]);
      if (v === "(none)") continue;
      acc.set(v, (acc.get(v) ?? 0) + r.n);
    }
    return [...acc].sort((a, b) => b[1] - a[1]);
  };
  const campOptions = useMemo(() => facetOf(crmBase("campaign"), "campaign"), [crmBase]);
  const srcOptions = useMemo(() => facetOf(crmBase("source"), "source"), [crmBase]);
  const medOptions = useMemo(() => facetOf(crmBase("medium"), "medium"), [crmBase]);
  const contentOptions = useMemo(() => facetOf(crmBase("content"), "content"), [crmBase]);

  /** Code options, narrowed by the campaign facet when one is chosen. */
  const codeOptions = useMemo(() => {
    const acc = new Map<string, number>();
    for (const r of crm?.codeRows ?? []) {
      if (utmCamp !== "all" && norm(r.campaign) !== utmCamp) continue;
      const v = norm(r.code);
      if (v === "(unlinked)") continue;
      acc.set(v, (acc.get(v) ?? 0) + r.n);
    }
    return [...acc].sort((a, b) => b[1] - a[1]);
  }, [crm?.codeRows, utmCamp]);

  // Stale selections degrade to "all" instead of zeroing the page.
  const activeCamp = utmCamp !== "all" && !campOptions.some(([v]) => v === utmCamp) ? "all" : utmCamp;
  const activeSrc = utmSrc !== "all" && !srcOptions.some(([v]) => v === utmSrc) ? "all" : utmSrc;
  const activeMed = utmMed !== "all" && !medOptions.some(([v]) => v === utmMed) ? "all" : utmMed;
  const activeContent = utmContent !== "all" && !contentOptions.some(([v]) => v === utmContent) ? "all" : utmContent;

  const crmFiltered = useMemo(
    () =>
      crmBase(null).filter(
        (r) =>
          (activeCamp === "all" || norm(r.campaign) === activeCamp) &&
          (activeSrc === "all" || norm(r.source) === activeSrc) &&
          (activeMed === "all" || norm(r.medium) === activeMed) &&
          (activeContent === "all" || norm(r.content) === activeContent),
      ),
    [crmBase, activeCamp, activeSrc, activeMed, activeContent],
  );

  const utmFiltersIdle = activeCamp === "all" && activeSrc === "all" && activeMed === "all" && activeContent === "all" && platformFilter === "all" && !q.trim();

  /**
   * Funnel aggregation. With ONLY a campaign code selected, the stage counts
   * come from the code's membership rows so its untagged leads (WhatsApp/email
   * button leads carrying no utm) are included; any UTM filter narrows to
   * utm-tagged leads by construction.
   */
  const crmAgg = useMemo(() => {
    const agg = emptyStages();
    if (code !== "all" && utmFiltersIdle) {
      for (const r of crm?.codeRows ?? []) if (norm(r.code) === code) addStage(agg, r.stage, r.state, r.n);
    } else {
      for (const r of crmFiltered) addStage(agg, r.stage, r.state, r.n);
    }
    return agg;
  }, [crm?.codeRows, code, utmFiltersIdle, crmFiltered]);

  const crmByCampaign = useMemo(() => {
    const m = new Map<string, CrmJoin>();
    for (const r of crmFiltered) {
      if (!inPlay(r.state)) continue;
      const k = norm(r.campaign);
      const cur = m.get(k) ?? { leads: 0, qualified: 0, deals: 0 };
      cur.leads += r.n;
      const st = norm(r.stage);
      if (st === "qualified") cur.qualified += r.n;
      if (st === "deal") cur.deals += r.n;
      m.set(k, cur);
    }
    return m;
  }, [crmFiltered]);

  const joinFor = useCallback(
    (r: CampaignRow): CrmJoin | null => {
      const byName = crmByCampaign.get(norm(r.campaign));
      if (byName) return byName;
      if (r.campaignId) return crmByCampaign.get(norm(r.campaignId)) ?? null;
      return null;
    },
    [crmByCampaign],
  );

  // ── Funnel ──────────────────────────────────────────────────────────────────
  const funnel = useMemo(
    () => [
      { label: "Leads", n: crmAgg.leads, note: "campaign-tagged, not closed" },
      { label: "Qualified", n: crmAgg.qualified, note: "at Qualified now" },
      { label: "Viewing", n: crmAgg.viewing, note: "at Viewing now" },
      { label: "Offer / Reserved", n: crmAgg.offerRes, note: "in negotiation" },
      { label: "Deal", n: crmAgg.deals, note: "reached Deal stage" },
    ],
    [crmAgg],
  );
  const funnelMax = Math.max(...funnel.map((s) => s.n), 1);

  const cur = totals.singleCurrency ?? "—";
  const cpl = crmAgg.leads > 0 && totals.singleCurrency ? totals.spend / crmAgg.leads : null;
  const cpql = crmAgg.qualified > 0 && totals.singleCurrency ? totals.spend / crmAgg.qualified : null;
  const selectedCount = PLATFORM_ORDER.reduce((n, p) => n + sel[p].length, 0);
  const goalsPresent = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.goal))], [data?.rows]);

  // ── Trends (platform + goal aware) ──────────────────────────────────────────
  const trend = useMemo(() => {
    const acc = new Map<string, { cost: number; leads: number }>();
    for (const d of data?.byDateFine ?? []) {
      if (platformFilter !== "all" && d.platform !== platformFilter) continue;
      if (goalFilter !== "all" && d.goal !== goalFilter) continue;
      const cur = acc.get(d.date) ?? { cost: 0, leads: 0 };
      cur.cost += d.cost;
      cur.leads += d.leads;
      acc.set(d.date, cur);
    }
    return [...acc].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));
  }, [data?.byDateFine, platformFilter, goalFilter]);

  const platformTrend = useMemo(() => {
    const dates = [...new Set((data?.byDateFine ?? []).map((d) => d.date))].sort();
    const series = PLATFORM_ORDER.map((p) => {
      const byDate = new Map<string, number>();
      for (const d of data?.byDateFine ?? []) {
        if (d.platform !== p) continue;
        if (goalFilter !== "all" && d.goal !== goalFilter) continue;
        byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.cost);
      }
      return { platform: p, points: dates.map((dt) => byDate.get(dt) ?? 0), any: byDate.size > 0 };
    }).filter((s) => s.any);
    return { dates, series };
  }, [data?.byDateFine, goalFilter]);

  const byGoal = useMemo(() => {
    const acc = new Map<CampaignGoal, number>();
    for (const r of mediaFiltered) acc.set(r.goal, (acc.get(r.goal) ?? 0) + r.cost);
    return [...acc].map(([goal, cost]) => ({ goal, cost })).sort((a, b) => b.cost - a.cost);
  }, [mediaFiltered]);

  // ── Platform comparison ─────────────────────────────────────────────────────
  const platformTable = useMemo(() => {
    const present = new Set<PaidPlatform>();
    for (const a of data?.accountsUsed ?? []) present.add(a.platform);
    for (const a of data?.emptyAccounts ?? []) present.add(a.platform);
    for (const f of data?.failures ?? []) present.add(f.platform);
    const needle = norm(q);
    const rows = regroup(
      (data?.rows ?? []).filter(
        (r) =>
          (goalFilter === "all" || r.goal === goalFilter) &&
          (!needle || norm(r.campaign).includes(needle) || norm(r.adset ?? "").includes(needle) || norm(r.ad ?? "").includes(needle) || norm(r.accountName).includes(needle)),
      ),
      "campaign",
    );
    const acc = new Map<PaidPlatform, { cost: number; impressions: number; clicks: number; result: number; n: number; currencies: Set<string> }>();
    for (const p of PLATFORM_ORDER) if (present.has(p)) acc.set(p, { cost: 0, impressions: 0, clicks: 0, result: 0, n: 0, currencies: new Set() });
    for (const r of rows) {
      const cur = acc.get(r.platform);
      if (!cur) continue;
      cur.cost += r.cost; cur.impressions += r.impressions; cur.clicks += r.clicks; cur.result += r.result; cur.n += 1;
      cur.currencies.add(r.currency);
    }
    const list = PLATFORM_ORDER.filter((p) => acc.has(p)).map((p) => ({ platform: p, ...acc.get(p)! }));
    const allCurs = new Set(list.flatMap((l) => [...l.currencies]));
    const total = {
      n: list.reduce((s, l) => s + l.n, 0),
      cost: list.reduce((s, l) => s + l.cost, 0),
      impressions: list.reduce((s, l) => s + l.impressions, 0),
      clicks: list.reduce((s, l) => s + l.clicks, 0),
      result: list.reduce((s, l) => s + l.result, 0),
      currency: allCurs.size === 1 ? [...allCurs][0] : "—",
      mixed: allCurs.size > 1,
    };
    return { list, total };
  }, [data?.rows, data?.accountsUsed, data?.emptyAccounts, data?.failures, goalFilter, q, regroup]);

  // ── Campaign tree: code → utm_campaign → ad set → ad ───────────────────────
  const mediaIndex = useMemo(() => {
    // Nested media index keyed by normalised campaign name AND Meta campaign id,
    // so a tree campaign node can find its ads either way.
    const byCampaign = new Map<string, { row: CampaignRow; adsets: Map<string, { row: CampaignRow; ads: CampaignRow[] }> }>();
    const campaignRows = regroup(data?.rows ?? [], "campaign");
    const adsetRows = regroup(data?.rows ?? [], "adset");
    const adRows = regroup(data?.rows ?? [], "ad");
    const entryFor = (key: string, row: CampaignRow) => {
      const e = byCampaign.get(key);
      if (e) return e;
      const fresh = { row, adsets: new Map<string, { row: CampaignRow; ads: CampaignRow[] }>() };
      byCampaign.set(key, fresh);
      return fresh;
    };
    for (const r of campaignRows) {
      const e = entryFor(norm(r.campaign), r);
      if (r.campaignId) byCampaign.set(norm(r.campaignId), e);
    }
    for (const r of adsetRows) {
      if (!r.adset) continue;
      const e = byCampaign.get(norm(r.campaign));
      if (e) e.adsets.set(r.adset, { row: r, ads: [] });
    }
    for (const r of adRows) {
      if (!r.adset || !r.ad) continue;
      byCampaign.get(norm(r.campaign))?.adsets.get(r.adset)?.ads.push(r);
    }
    return byCampaign;
  }, [data?.rows, regroup]);

  const tree = useMemo(() => {
    // Code level from Engage membership rows; campaign level carries CRM stages
    // plus its matched media; deeper levels are media-only (the CRM records
    // nothing finer than the campaign tag).
    const codes = new Map<string, { agg: StageAgg; campaigns: Map<string, StageAgg> }>();
    for (const r of crm?.codeRows ?? []) {
      const c = norm(r.code);
      if (code !== "all" && c !== code) continue;
      if (activeCamp !== "all" && norm(r.campaign) !== activeCamp) continue;
      const needle = norm(q);
      if (needle && !c.includes(needle) && !norm(r.campaign).includes(needle)) continue;
      const entry = codes.get(c) ?? { agg: emptyStages(), campaigns: new Map<string, StageAgg>() };
      addStage(entry.agg, r.stage, r.state, r.n);
      const ck = norm(r.campaign);
      const camp = entry.campaigns.get(ck) ?? emptyStages();
      addStage(camp, r.stage, r.state, r.n);
      entry.campaigns.set(ck, camp);
      codes.set(c, entry);
    }
    return [...codes.entries()]
      .map(([c, v]) => ({
        code: c,
        agg: v.agg,
        campaigns: [...v.campaigns.entries()].map(([name, agg]) => ({ name, agg, media: mediaIndex.get(name) ?? null })).sort((a, b) => b.agg.leads - a.agg.leads),
      }))
      .sort((a, b) => b.agg.leads - a.agg.leads)
      .slice(0, 40);
  }, [crm?.codeRows, code, activeCamp, q, mediaIndex]);

  const toggleNode = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rowName = (r: CampaignRow) => (viewLevel === "ad" ? r.ad ?? r.adset ?? r.campaign : viewLevel === "adset" ? r.adset ?? r.campaign : r.campaign);
  const rowContext = (r: CampaignRow) =>
    viewLevel === "ad" ? [r.campaign, r.adset].filter(Boolean).join(" › ") : viewLevel === "adset" ? r.campaign : null;

  const filtersActive = platformFilter !== "all" || goalFilter !== "all" || code !== "all" || activeCamp !== "all" || activeSrc !== "all" || activeMed !== "all" || activeContent !== "all" || q.trim() !== "";

  const explorerRows = useMemo(() => {
    const needle = norm(explorerQ);
    if (!needle) return mediaRows;
    return mediaRows.filter(
      (r) => norm(r.campaign).includes(needle) || norm(r.adset ?? "").includes(needle) || norm(r.ad ?? "").includes(needle) || norm(r.accountName).includes(needle),
    );
  }, [mediaRows, explorerQ]);

  const stageCells = (a: StageAgg) => (
    <>
      <td style={{ textAlign: "right", fontWeight: 600, color: C.green }}>{fmt(a.leads)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.qualified)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.viewing)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.offerRes)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.deals)}</td>
    </>
  );
  const emptyStageCells = (
    <>
      <td style={{ textAlign: "right" }} className="muted">—</td>
      <td style={{ textAlign: "right" }} className="muted">—</td>
      <td style={{ textAlign: "right" }} className="muted">—</td>
      <td style={{ textAlign: "right" }} className="muted">—</td>
      <td style={{ textAlign: "right" }} className="muted">—</td>
    </>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Digital Performance</h1>
          <p className="page-sub">
            Paid media via Supermetrics · lead funnel via Engage (Metabase) · {data ? data.label : "loading…"}
            {data && loading ? " · refreshing…" : ""}
          </p>
        </div>
        <div className="filter-row" style={{ flexWrap: "wrap" }}>
          <DateRangePicker initialFrom={from} initialTo={to} onApply={applyRange} />
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

          {/* ── Filters — everything on the page answers to these ────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <button className={`filter-btn${platformFilter === "all" ? " active" : ""}`} onClick={() => setPlatformFilter("all")}>All platforms</button>
              {PLATFORM_ORDER.filter((p) => (data.rows.some((r) => r.platform === p) || (crm?.rows ?? []).some((r) => srcMatches(p, r.source)))).map((p) => (
                <button key={p} className={`filter-btn${platformFilter === p ? " active" : ""}`} onClick={() => setPlatformFilter(p)} style={platformFilter === p ? { background: PLATFORM_COLOR[p], borderColor: PLATFORM_COLOR[p] } : undefined}>
                  {PLATFORMS[p].label}
                </button>
              ))}
              <span style={{ width: 10 }} />
              <button className={`filter-btn${goalFilter === "all" ? " active" : ""}`} onClick={() => setGoalFilter("all")}>All goals</button>
              {goalsPresent.map((g) => (
                <button key={g} className={`filter-btn${goalFilter === g ? " active" : ""}`} onClick={() => setGoalFilter(g)}>{GOAL_LABELS[g]}</button>
              ))}
              {filtersActive && (
                <button className="filter-btn" style={{ marginLeft: "auto" }} onClick={() => { setPlatformFilter("all"); setGoalFilter("all"); setCode("all"); setUtmCamp("all"); setUtmSrc("all"); setUtmMed("all"); setUtmContent("all"); setQ(""); }}>
                  Clear all
                </button>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 11 }}>
                Engage <HelpTip text="Straight from Engage: campaign_code is the campaign entity's reference (a code groups several utm_campaigns); the four utm_* fields are what each lead's record carries. All five are searchable and interlinked — each offers only values that exist under the other active filters." />
              </span>
              <FilterSelect label="campaign_code" value={code} options={codeOptions} onChange={setCode} width={230} />
              <FilterSelect label="utm_campaign" value={activeCamp} options={campOptions} onChange={setUtmCamp} width={230} />
              <FilterSelect label="utm_source" value={activeSrc} options={srcOptions} onChange={setUtmSrc} width={165} />
              <FilterSelect label="utm_medium" value={activeMed} options={medOptions} onChange={setUtmMed} width={160} />
              <FilterSelect label="utm_content" value={activeContent} options={contentOptions} onChange={setUtmContent} width={185} />
              <input className="search-box" style={{ flex: 1, minWidth: 150 }} placeholder="Search everything…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>

          {/* ── KPIs ─────────────────────────────────────────────────────────── */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">Spend <HelpTip text={totals.singleCurrency ? `Media spend for the current filters, in ${totals.singleCurrency}.` : "The filtered accounts bill in more than one currency; the split is shown below and nothing is summed across currencies."} /></div>
              <div className="kpi-value">{totals.singleCurrency ? money(totals.spend, cur) : <span style={{ fontSize: 15 }}>Mixed currency</span>}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Leads <HelpTip text="Campaign-tagged leads created in the CRM in this range, excluding closed ones. With only a campaign_code selected this includes the code's untagged leads (WhatsApp/email buttons); UTM filters narrow to tagged leads. Source: Engage via Metabase." /></div>
              <div className="kpi-value" style={{ color: C.green }}>{crmLoading ? "…" : crm?.error && !crm.rows.length ? "—" : fmt(crmAgg.leads)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Qualified <HelpTip text="Leads sitting at the Qualified stage right now, still open. Closed leads are dropped." /></div>
              <div className="kpi-value">{crmLoading ? "…" : fmt(crmAgg.qualified)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Viewing <HelpTip text="Leads at the Viewing stage right now, still open." /></div>
              <div className="kpi-value">{crmLoading ? "…" : fmt(crmAgg.viewing)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Deal stage <HelpTip text="Leads currently at the Deal stage of the pipeline (not closed). A stage snapshot — not the same as a signed transaction in the deals table." /></div>
              <div className="kpi-value">{crmLoading ? "…" : fmt(crmAgg.deals)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Cost / lead <HelpTip text={totals.singleCurrency ? "Filtered spend divided by leads, and by currently-qualified leads." : "Hidden while the filtered accounts span multiple currencies."} /></div>
              <div className="kpi-value" style={{ fontSize: 16 }}>
                {cpl == null ? "—" : money(cpl, cur)}
                {cpql != null && <span className="muted" style={{ fontSize: 12 }}> · {money(cpql, cur)} / qualified</span>}
              </div>
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

          {/* ── Funnel ───────────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div className="chart-title">
              Lead funnel <HelpTip text="Campaign-tagged CRM leads by the pipeline stage they sit at today, closed leads dropped. Each stage shows its share of leads." />
            </div>
            <div className="chart-sub">
              {crmLoading ? "CRM loading…" : crm?.error && !crm.rows.length ? `CRM unavailable: ${crm.error}` : `${fmt(crmAgg.leads)} open leads${code !== "all" ? ` · code ${code}` : ""} · ${crm?.label ?? ""}${crm?.truncated ? " · largest groups only (row cap hit)" : ""}${crm?.error ? ` · ${crm.error}` : ""}`}
            </div>
            <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
              {funnel.map((s, i) => (
                <div key={s.label} style={{ display: "grid", gridTemplateColumns: "150px 1fr 170px", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.green }}>
                    {s.label}
                    <div className="muted" style={{ fontSize: 10, fontWeight: 400 }}>{s.note}</div>
                  </div>
                  <div style={{ background: "var(--warm-white)", borderRadius: 5, height: 26, position: "relative", overflow: "hidden" }}>
                    <div style={{ width: `${Math.max((s.n / funnelMax) * 100, s.n > 0 ? 1.5 : 0)}%`, background: C.green, opacity: i === 0 ? 0.9 : 0.7, height: "100%", borderRadius: 5, transition: "width .3s" }} />
                  </div>
                  <div style={{ fontSize: 12, textAlign: "right" }}>
                    <strong>{fmt(s.n)}</strong>
                    {i > 0 && funnel[0].n > 0 && <span className="muted"> · {pct0(s.n / funnel[0].n)} of leads</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Campaign tree ────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Campaign tree <HelpTip text="Engage's own hierarchy: a campaign_code groups several utm_campaigns; under each campaign sit its ad sets and ads from the ad platforms. Lead stages exist down to the campaign level — the CRM records nothing finer — so ad sets and ads show media numbers only. Expand rows with the arrows." />
              </span>
              <button className="filter-btn" onClick={() => setTreeOpen((v) => !v)}>{treeOpen ? "Hide" : "Show"}</button>
            </div>
            <div className="chart-sub">campaign_code → utm_campaign → ad set → ad · {tree.length} code{tree.length === 1 ? "" : "s"}</div>
            {treeOpen && (
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 320 }}>Node</th>
                      <th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Impr.</th>
                      <th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>Leads</th>
                      <th style={{ textAlign: "right" }}>Qualified</th>
                      <th style={{ textAlign: "right" }}>Viewing</th>
                      <th style={{ textAlign: "right" }}>Offer/Res.</th>
                      <th style={{ textAlign: "right" }}>Deal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tree.map((node) => {
                      const codeKey = `c|${node.code}`;
                      const codeOpen = expanded.has(codeKey);
                      return (
                        <FragmentRows key={codeKey}>
                          <tr style={{ background: "var(--warm-white)" }}>
                            <td style={{ fontWeight: 700 }}>
                              <button className="filter-btn" style={{ padding: "0 7px", marginRight: 6, fontSize: 11 }} onClick={() => toggleNode(codeKey)}>
                                {codeOpen ? "▾" : "▸"}
                              </button>
                              {node.code} <span className="muted" style={{ fontWeight: 400, fontSize: 10 }}>code · {node.campaigns.length} campaign{node.campaigns.length === 1 ? "" : "s"}</span>
                            </td>
                            <td style={{ textAlign: "right" }} className="muted">—</td>
                            <td style={{ textAlign: "right" }} className="muted">—</td>
                            <td style={{ textAlign: "right" }} className="muted">—</td>
                            {stageCells(node.agg)}
                          </tr>
                          {codeOpen &&
                            node.campaigns.map((camp) => {
                              const campKey = `${codeKey}|p|${camp.name}`;
                              const campOpen = expanded.has(campKey);
                              const m = camp.media;
                              const adsets = m ? [...m.adsets.values()].sort((a, b) => b.row.cost - a.row.cost) : [];
                              return (
                                <FragmentRows key={campKey}>
                                  <tr>
                                    <td style={{ paddingLeft: 34 }}>
                                      {adsets.length > 0 ? (
                                        <button className="filter-btn" style={{ padding: "0 7px", marginRight: 6, fontSize: 11 }} onClick={() => toggleNode(campKey)}>
                                          {campOpen ? "▾" : "▸"}
                                        </button>
                                      ) : (
                                        <span style={{ display: "inline-block", width: 30 }} />
                                      )}
                                      {camp.name}
                                      {m && <span style={{ color: PLATFORM_COLOR[m.row.platform], fontSize: 10 }}> ● {PLATFORMS[m.row.platform].label}</span>}
                                      {!m && camp.name !== "(none)" && <span className="muted" style={{ fontSize: 10 }}> · no matching ads in range</span>}
                                      {camp.name === "(none)" && <span className="muted" style={{ fontSize: 10 }}> · leads with no utm_campaign</span>}
                                    </td>
                                    <td style={{ textAlign: "right" }}>{m ? money(m.row.cost, m.row.currency) : "—"}</td>
                                    <td style={{ textAlign: "right" }}>{m ? fmtK(m.row.impressions) : "—"}</td>
                                    <td style={{ textAlign: "right" }}>{m ? fmtK(m.row.clicks) : "—"}</td>
                                    {stageCells(camp.agg)}
                                  </tr>
                                  {campOpen &&
                                    adsets.map((as) => {
                                      const asKey = `${campKey}|s|${as.row.adset}`;
                                      const asOpen = expanded.has(asKey);
                                      const ads = [...as.ads].sort((a, b) => b.cost - a.cost);
                                      return (
                                        <FragmentRows key={asKey}>
                                          <tr>
                                            <td style={{ paddingLeft: 64 }}>
                                              {ads.length > 0 ? (
                                                <button className="filter-btn" style={{ padding: "0 7px", marginRight: 6, fontSize: 11 }} onClick={() => toggleNode(asKey)}>
                                                  {asOpen ? "▾" : "▸"}
                                                </button>
                                              ) : (
                                                <span style={{ display: "inline-block", width: 30 }} />
                                              )}
                                              <span style={{ fontSize: 12 }}>{as.row.adset}</span> <span className="muted" style={{ fontSize: 10 }}>ad set</span>
                                            </td>
                                            <td style={{ textAlign: "right" }}>{money(as.row.cost, as.row.currency)}</td>
                                            <td style={{ textAlign: "right" }}>{fmtK(as.row.impressions)}</td>
                                            <td style={{ textAlign: "right" }}>{fmtK(as.row.clicks)}</td>
                                            {emptyStageCells}
                                          </tr>
                                          {asOpen &&
                                            ads.map((ad) => (
                                              <tr key={`${asKey}|a|${ad.ad}`}>
                                                <td style={{ paddingLeft: 100, fontSize: 12 }}>
                                                  {ad.ad} <span className="muted" style={{ fontSize: 10 }}>ad · {ad.resultLabel.toLowerCase()}: {fmt(ad.result)}</span>
                                                </td>
                                                <td style={{ textAlign: "right" }}>{money(ad.cost, ad.currency)}</td>
                                                <td style={{ textAlign: "right" }}>{fmtK(ad.impressions)}</td>
                                                <td style={{ textAlign: "right" }}>{fmtK(ad.clicks)}</td>
                                                {emptyStageCells}
                                              </tr>
                                            ))}
                                        </FragmentRows>
                                      );
                                    })}
                                </FragmentRows>
                              );
                            })}
                        </FragmentRows>
                      );
                    })}
                    {!tree.length && (
                      <tr><td colSpan={9} className="muted">{crmLoading ? "Loading from Engage…" : "No campaign codes match the filters."}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Trends ───────────────────────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">
                Spend &amp; leads over time <HelpTip text="Leads here are platform-reported (Meta website + form leads; Google/LinkedIn conversions) so they exist per day. Platform and goal filters apply; Engage filters can't reach this chart because the ad platforms don't report by UTM." />
              </div>
              <div className="chart-sub">Daily · {data.label}</div>
              <div className="chart-canvas-wrap">
                {trend.length ? (
                  <ChartBox
                    type="line"
                    data={{
                      labels: trend.map((d) => d.date.slice(5)),
                      datasets: [
                        { label: `Spend${cur !== "—" ? ` (${cur})` : ""}`, data: trend.map((d) => d.cost), borderColor: C.dark, backgroundColor: "rgba(31,52,63,.08)", fill: true, tension: 0.3, yAxisID: "y" },
                        { label: "Leads", data: trend.map((d) => d.leads), borderColor: C.green, backgroundColor: "transparent", tension: 0.3, yAxisID: "y1" },
                      ],
                    }}
                    options={{
                      interaction: { mode: "index", intersect: false },
                      scales: {
                        y: { beginAtZero: true, position: "left", title: { display: true, text: "Spend" } },
                        y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Leads" }, ticks: { precision: 0 } },
                      },
                    }}
                  />
                ) : (
                  <div className="empty-state">No daily data for the current filters.</div>
                )}
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">Spend by platform over time</div>
              <div className="chart-sub">Daily · Google in green, Meta in blue{goalFilter !== "all" ? ` · ${GOAL_LABELS[goalFilter as CampaignGoal]} campaigns` : ""}</div>
              <div className="chart-canvas-wrap">
                {platformTrend.series.length ? (
                  <ChartBox
                    type="line"
                    data={{
                      labels: platformTrend.dates.map((d) => d.slice(5)),
                      datasets: platformTrend.series.map((s) => ({
                        label: PLATFORMS[s.platform].label,
                        data: s.points,
                        borderColor: PLATFORM_COLOR[s.platform],
                        backgroundColor: "transparent",
                        tension: 0.3,
                      })),
                    }}
                    options={{ interaction: { mode: "index", intersect: false }, scales: { y: { beginAtZero: true } } }}
                  />
                ) : (
                  <div className="empty-state">No daily data for the current filters.</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Mix + platform comparison ────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Where the money goes</div>
              <div className="chart-sub">
                {totals.singleCurrency ? `Spend share by platform (${cur})` : "Impression share by platform — spend spans multiple currencies"} · and by campaign goal
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div className="chart-canvas-wrap">
                  {platformTable.list.some((p) => p.cost > 0 || p.impressions > 0) ? (
                    <ChartBox
                      type="doughnut"
                      data={{
                        labels: platformTable.list.map((p) => PLATFORMS[p.platform].label),
                        datasets: [{
                          data: platformTable.list.map((p) => (totals.singleCurrency ? p.cost : p.impressions)),
                          backgroundColor: platformTable.list.map((p) => PLATFORM_COLOR[p.platform]),
                          borderWidth: 1,
                        }],
                      }}
                      options={{ plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } } }, cutout: "55%" }}
                    />
                  ) : (
                    <div className="empty-state">Nothing in range.</div>
                  )}
                </div>
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
                    <div className="empty-state">Nothing in range.</div>
                  )}
                </div>
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">
                Platform comparison <HelpTip text="Every selected platform, including quiet ones, plus a total. Goal and search filters apply; the platform filter deliberately does not — a comparison with the others hidden compares nothing. Rates are derived from raw totals." />
              </div>
              <div className="chart-sub">Totals per platform · {data.label}</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th>Platform</th><th style={{ textAlign: "right" }}>Campaigns</th><th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Impr.</th><th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>CTR</th><th style={{ textAlign: "right" }}>Results</th>
                    </tr>
                  </thead>
                  <tbody>
                    {platformTable.list.map((p) => {
                      const pc = p.currencies.size === 1 ? [...p.currencies][0] : "—";
                      return (
                        <tr key={p.platform}>
                          <td><span style={{ color: PLATFORM_COLOR[p.platform], fontWeight: 600 }}>{PLATFORMS[p.platform].label}</span></td>
                          <td style={{ textAlign: "right" }}>{p.n}</td>
                          <td style={{ textAlign: "right" }}>{money(p.cost, pc)}</td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.impressions)}</td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.clicks)}</td>
                          <td style={{ textAlign: "right" }}>{pct1(ratio(p.clicks, p.impressions))}</td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p.result)}</td>
                        </tr>
                      );
                    })}
                    {platformTable.list.length > 0 && (
                      <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
                        <td>Total</td>
                        <td style={{ textAlign: "right" }}>{platformTable.total.n}</td>
                        <td style={{ textAlign: "right" }} title={platformTable.total.mixed ? "Spend spans multiple currencies and is not summed" : undefined}>
                          {platformTable.total.mixed ? "mixed" : money(platformTable.total.cost, platformTable.total.currency)}
                        </td>
                        <td style={{ textAlign: "right" }}>{fmtK(platformTable.total.impressions)}</td>
                        <td style={{ textAlign: "right" }}>{fmtK(platformTable.total.clicks)}</td>
                        <td style={{ textAlign: "right" }}>{pct1(ratio(platformTable.total.clicks, platformTable.total.impressions))}</td>
                        <td style={{ textAlign: "right" }}>{fmt(platformTable.total.result)}</td>
                      </tr>
                    )}
                    {!platformTable.list.length && <tr><td colSpan={7} className="muted">No platforms selected.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Explorer ─────────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Explorer <HelpTip text="Every row with spend in range, biggest first. Result is goal-aware — leads for lead campaigns, link clicks for traffic, website conversions for sales. CRM columns join by utm_campaign (name or Meta campaign id) at campaign level; ad sets and ads inherit no CRM figures because the CRM records only the campaign tag." />
              </span>
              <button className="filter-btn" onClick={() => setExplorerOpen((v) => !v)}>{explorerOpen ? "Hide" : "Show"}</button>
            </div>
            <div className="chart-sub">
              {explorerRows.length} row{explorerRows.length === 1 ? "" : "s"} · {LEVEL_LABEL[viewLevel].toLowerCase()}
              {data.truncated ? " · some accounts hit the row cap — totals may undercount" : ""}
            </div>
            {explorerOpen && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0", alignItems: "center" }}>
                  {(Object.keys(LEVEL_LABEL) as PaidLevel[]).map((l) => (
                    <button key={l} className={`filter-btn${viewLevel === l ? " active" : ""}`} onClick={() => setViewLevel(l)}>{LEVEL_LABEL[l]}</button>
                  ))}
                  <input className="search-box" style={{ flex: 1, minWidth: 160 }} placeholder="Filter these rows…" value={explorerQ} onChange={(e) => setExplorerQ(e.target.value)} />
                </div>
                <div className="table-scroll">
                  <table className="perf-table">
                    <thead>
                      <tr>
                        <th>{LEVEL_LABEL[viewLevel].replace(/s$/, "")}</th><th>Account</th><th>Goal</th>
                        <th style={{ textAlign: "right" }}>Spend</th>
                        <th style={{ textAlign: "right" }}>Impr.</th>
                        <th style={{ textAlign: "right" }}>Clicks</th>
                        <th style={{ textAlign: "right" }}>CTR</th>
                        <th style={{ textAlign: "right" }}>Result</th>
                        <th>Measured as</th>
                        {viewLevel === "campaign" && (
                          <>
                            <th style={{ textAlign: "right" }}>Leads</th>
                            <th style={{ textAlign: "right" }}>Qualified</th>
                            <th style={{ textAlign: "right" }}>Deals</th>
                            <th style={{ textAlign: "right" }}>Cost / lead</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {explorerRows.slice(0, 80).map((r) => {
                        const j = viewLevel === "campaign" ? joinFor(r) : null;
                        const ctx = rowContext(r);
                        const shallow = DEPTH[r.granularity] < DEPTH[viewLevel];
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
                            {viewLevel === "campaign" && (
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
                      {!explorerRows.length && <tr><td colSpan={viewLevel === "campaign" ? 13 : 9} className="muted">No rows match the filters.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {explorerRows.length > 80 && <div className="chart-sub" style={{ marginTop: 8 }}>Showing the 80 highest-spending of {explorerRows.length} rows — narrow with the filters or search.</div>}
              </>
            )}
          </div>

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
                  Supermetrics licenses a subset of ad accounts for querying — plans cap how many can be prioritised, so adding one
                  may mean swapping another out. Manage the list here and these accounts start loading on the next refresh:{" "}
                  {[...new Set(data.failures.filter((f) => f.notPrioritised).map((f) => f.platform))].map((p, i) => (
                    <span key={p}>
                      {i > 0 && " · "}
                      <a href={`${SUPERMETRICS_SUBSCRIPTION_URL}#datasource-${PLATFORMS[p].dsId}`} target="_blank" rel="noopener noreferrer">
                        {PLATFORMS[p].label} prioritised accounts
                      </a>
                    </span>
                  ))}
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
            {" "}· lead funnel and campaign codes from Engage (Metabase), joined on utm_campaign, closed leads excluded · rates derived from raw totals.
          </div>
        </>
      )}
    </div>
  );
}

/** Keyed fragment so sibling groups of <tr>s can nest without extra DOM. */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
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
