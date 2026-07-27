// PostHog Web/SEO analytics, read via the HogQL Query API. Server-only.
//
// Needs a PostHog *personal* API key (phx_…) with Query:Read scope in
// POSTHOG_API_KEY. Project id + host default to the betterhomes project so the
// key alone is enough. No key / blocked egress / error → returns a graceful
// "not connected" shape so the page still renders.
//
// Bot handling: PostHog tags obvious bots via $virt_is_bot, but sophisticated
// headless-Chrome crawlers (e.g. the AWS us-east-1 / "Ashburn" traffic that
// dominated this site) spoof normal user agents and slip past it. So we treat a
// hit as automated if $virt_is_bot is true OR it comes from a known cloud
// datacenter city. "Humans only" (the default) excludes those.
const HOST = process.env.POSTHOG_HOST || "https://us.posthog.com";
const PROJECT = process.env.POSTHOG_PROJECT_ID || "198002";

// High-confidence pure-datacenter cities (AWS/GCP regions). Kept tight to avoid
// dropping real users — Ashburn (AWS us-east-1) alone was ~92% of bogus US hits.
const DATACENTER_CITIES = ["Ashburn", "Boardman", "Council Bluffs", "The Dalles"];

const SEARCH_ENGINES = ["google.", "bing.", "yahoo.", "duckduckgo.", "ecosia.", "yandex.", "baidu.", "brave."];

async function hogql(sql: string, timeoutMs = Number(process.env.POSTHOG_TIMEOUT_MS || 15000)): Promise<any[][] | null> {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return null;
  // Hard timeout so one slow/heavy query can never hang the server render (which
  // would leave the tab stuck on its loading skeleton). On timeout we return null
  // and the caller degrades gracefully to an empty section. Heavy per-session
  // scans can pass a larger timeout.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST.replace(/\/$/, "")}/api/projects/${PROJECT}/query/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[posthog] query HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch (e) {
    console.error(`[posthog] query error: ${e instanceof Error ? e.message : String(e)} — ${sql.slice(0, 120)}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface FlowNode { id: string; label: string; col: number; value: number; kind: string; breakdown?: { label: string; value: number }[] }
export interface FlowLink { source: string; target: string; value: number }
export interface FlowData { nodes: FlowNode[]; links: FlowLink[]; sessions: number }

export interface WebMetrics {
  connected: boolean; // is a PostHog key configured
  hasData: boolean; // did we get any $pageview rows (incl. bots)
  humansOnly: boolean; // is the bot filter applied
  days: number;
  label: string; // human range label
  from: string; // resolved range start, YYYY-MM-DD — seeds the client date pickers
  to: string; // resolved range end, YYYY-MM-DD
  generatedAt: string; // when PostHog was queried, ISO — the "updated" stamp
  overview: { pageviews: number; visitors: number; sessions: number; organic: number } | null;
  bots: { pageviews: number; pct: number }; // automated traffic detected in range
  trend: { day: string; pageviews: number; visitors: number }[];
  topPages: { path: string; views: number }[];
  sources: { source: string; sessions: number }[];
  countries: { country: string; visitors: number }[];
  flow: FlowData; // Channel → Landing → outcome touchpoint flow
}

// Group a raw path into a page category, so the flow clubs the many individual
// URLs into a handful of meaningful buckets (Buy listings, Blog, etc.). '' means
// the session had no pageview at that step (they'd left) — we emit no node for it.
function pageBucket(e: string): string {
  return (
    `multiIf(${e} = '', '', ` +
    `${e} = '/' OR ${e} = '/en' OR ${e} = '/en/' OR ${e} = '/ar' OR ${e} = '/ar/', 'Home', ` +
    `${e} LIKE '%/buy%', 'Buy listings', ` +
    `${e} LIKE '%/rent%', 'Rent listings', ` +
    `${e} LIKE '%/commercial%', 'Commercial', ` +
    `${e} LIKE '%/blog%' AND (${e} LIKE '%market%' OR ${e} LIKE '%report%'), 'Blog: Market reports', ` +
    `${e} LIKE '%/blog%', 'Blog', ` +
    `${e} LIKE '%/area-guide%', 'Area guides', ` +
    `${e} LIKE '%/developer%', 'Developers', ` +
    `${e} LIKE '%/branch%', 'Branches', ` +
    `${e} LIKE '%/agent%' OR ${e} LIKE '%/team%', 'Agents', ` +
    `'Other')`
  );
}

// Page-journey flow: per session, the entry source (channel) then the first 3
// pages (bucketed), shown as Source → 1st → 2nd → 3rd page. Drop-off is implied
// — a session with fewer pages simply has no further link (no "Exit" node).
// Optional pageFilter keeps only sessions whose path sequence touches a substring.
async function getUserFlow(since: string, human: string, pageFilter?: string[], exact = false): Promise<FlowData> {
  let filterWhere = "";
  if (pageFilter && pageFilter.length) {
    // Accept a bare slug ("buy"), a path ("/en/buy"), or a full page URL pasted
    // from the breakdown ("https://www.bhomes.com/betterhomes-mobile-app"): drop
    // the protocol, keep host + path chars. Multiple entries are OR-ed together.
    //  • contains (default): substring match against the host+path array
    //  • exact: the visited path OR host+path equals the term
    const terms = pageFilter
      .map((t) => t.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9/_.-]/g, ""))
      .filter(Boolean);
    if (terms.length) {
      const clause = exact
        ? (t: string) => `(arrayExists(p -> p = '${t}', paths) OR arrayExists(p -> p = '${t}', fullpaths))`
        : (t: string) => `arrayExists(p -> p LIKE '%${t}%', fullpaths)`;
      filterWhere = ` WHERE ${terms.map(clause).join(" OR ")}`;
    }
  }
  // Entry-source classification. Order matters (first match wins):
  //  • Direct — no referrer ('' or PostHog's '$direct' sentinel) or a self-referral (bhomes.com)
  //  • AI Assistant — ChatGPT/Perplexity/Claude/Gemini/Copilot (checked before Organic so gemini.google → AI)
  //  • Organic Search — search engines
  //  • Social — checked with an EXACT t.co match (avoids '%t.co%' catching chatgpt.com / trustpilot.com)
  //  • Referral — anything else (a link on another site)
  const chan =
    `multiIf(` +
    `ref = '' OR ref = '$direct' OR ref LIKE '%bhomes.com%', 'Direct', ` +
    `ref LIKE '%chatgpt.%' OR ref LIKE '%openai.%' OR ref LIKE '%perplexity.%' OR ref LIKE '%claude.%' OR ref LIKE '%gemini.google%' OR ref LIKE '%copilot.%', 'AI Assistant', ` +
    `ref LIKE '%google.%' OR ref LIKE '%bing.%' OR ref LIKE '%yahoo.%' OR ref LIKE '%duckduckgo.%' OR ref LIKE '%ecosia.%' OR ref LIKE '%yandex.%' OR ref LIKE '%baidu.%' OR ref LIKE '%brave.%', 'Organic Search', ` +
    `ref LIKE '%facebook.%' OR ref LIKE '%instagram.%' OR ref LIKE '%linkedin.%' OR ref = 't.co' OR ref LIKE '%youtube.%' OR ref LIKE '%tiktok.%', 'Social', ` +
    `'Referral')`;
  // one row per session: entry referrer + ordered page paths. The heavier
  // host+path array (fullpaths) is built ONLY when a page filter needs it — on a
  // normal load we don't pay for it.
  const fullpathsSel = filterWhere
    ? `, arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((timestamp, lower(concat(coalesce(properties.$host, ''), coalesce(nullif(properties.$pathname, ''), '/'))))))) AS fullpaths `
    : ` `;
  const innerSessions =
    `SELECT argMin(coalesce(properties.$referring_domain, ''), timestamp) AS ref, ` +
    `arrayMap(x -> x.2, arraySort(x -> x.1, groupArray((timestamp, lower(coalesce(nullif(properties.$pathname, ''), '/')))))) AS paths` +
    fullpathsSel +
    `FROM events WHERE event = '$pageview' AND ${since}${human} AND properties.$session_id != '' GROUP BY properties.$session_id`;
  const [rows, bdRows, pageBdRows] = await Promise.all([
    hogql(
      `SELECT ${chan} AS channel, ${pageBucket("arrayElement(paths, 1)")} AS b1, ${pageBucket("arrayElement(paths, 2)")} AS b2, ${pageBucket("arrayElement(paths, 3)")} AS b3, count() AS sessions ` +
        `FROM (${innerSessions})${filterWhere} GROUP BY channel, b1, b2, b3 ORDER BY sessions DESC LIMIT 500`,
    ),
    hogql(
      `SELECT ${chan} AS channel, if(ref = '' OR ref = '$direct', '(direct)', ref) AS domain, count() AS sessions ` +
        `FROM (${innerSessions})${filterWhere} GROUP BY channel, domain ORDER BY sessions DESC LIMIT 300`,
    ),
    // per-bucket page composition (host + path) so a page node can show exactly
    // which real pages — across subdomains like survey./promo. — make it up.
    hogql(
      `SELECT ${pageBucket("path")} AS bucket, concat(host, path) AS page, count() AS views ` +
        `FROM (SELECT lower(coalesce(nullif(properties.$pathname, ''), '/')) AS path, coalesce(properties.$host, '') AS host ` +
        `FROM events WHERE event = '$pageview' AND ${since}${human}) GROUP BY bucket, page ORDER BY views DESC LIMIT 2000`,
    ),
  ]);
  if (!rows || !rows.length) return { nodes: [], links: [], sessions: 0 };

  const data = rows.map((r) => ({ channel: String(r[0] || "Referral"), b1: String(r[1] || ""), b2: String(r[2] || ""), b3: String(r[3] || ""), sessions: Number(r[4] || 0) }));
  const sessions = data.reduce((a, b) => a + b.sessions, 0);

  // top 5 page categories across the page steps; the rest fold into "Other"
  const catTot = new Map<string, number>();
  for (const d of data) for (const c of [d.b1, d.b2, d.b3]) if (c) catTot.set(c, (catTot.get(c) ?? 0) + d.sessions);
  const top = new Set([...catTot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]));
  const cat = (c: string) => (!c ? "" : top.has(c) ? c : "Other");

  const l01 = new Map<string, number>(), l12 = new Map<string, number>(), l23 = new Map<string, number>();
  const v0 = new Map<string, number>(), v1 = new Map<string, number>(), v2 = new Map<string, number>(), v3 = new Map<string, number>();
  for (const d of data) {
    const ch = d.channel, p1 = cat(d.b1), p2 = cat(d.b2), p3 = cat(d.b3);
    if (!p1) continue;
    v0.set(ch, (v0.get(ch) ?? 0) + d.sessions);
    v1.set(p1, (v1.get(p1) ?? 0) + d.sessions);
    l01.set(`${ch}|||${p1}`, (l01.get(`${ch}|||${p1}`) ?? 0) + d.sessions);
    if (p2) {
      v2.set(p2, (v2.get(p2) ?? 0) + d.sessions);
      l12.set(`${p1}|||${p2}`, (l12.get(`${p1}|||${p2}`) ?? 0) + d.sessions);
      if (p3) {
        v3.set(p3, (v3.get(p3) ?? 0) + d.sessions);
        l23.set(`${p2}|||${p3}`, (l23.get(`${p2}|||${p3}`) ?? 0) + d.sessions);
      }
    }
  }

  const nodes: FlowNode[] = [];
  const mk = (m: Map<string, number>, col: number) => {
    for (const [label, value] of [...m].sort((a, b) => b[1] - a[1])) nodes.push({ id: `${col}:${label}`, label, col, value, kind: col === 0 ? "source" : "page" });
  };
  mk(v0, 0); mk(v1, 1); mk(v2, 2); mk(v3, 3);

  // per-source domain breakdown → attach to the entry-source (col 0) nodes so the
  // UI can show "how many from each domain" on hover and expand it on click.
  const byChannel = new Map<string, { label: string; value: number }[]>();
  for (const r of bdRows ?? []) {
    const ch = String(r[0] || "Referral");
    const arr = byChannel.get(ch) ?? [];
    arr.push({ label: String(r[1] || "(unknown)"), value: Number(r[2] || 0) });
    byChannel.set(ch, arr);
  }
  const foldTop = (arr: { label: string; value: number }[]) => {
    const sorted = [...arr].sort((a, b) => b.value - a.value);
    if (sorted.length <= 12) return sorted;
    const rest = sorted.slice(12).reduce((a, b) => a + b.value, 0);
    return rest > 0 ? [...sorted.slice(0, 12), { label: `+${sorted.length - 12} more`, value: rest }] : sorted.slice(0, 12);
  };
  for (const n of nodes) if (n.col === 0) n.breakdown = foldTop(byChannel.get(n.label) ?? []);

  // per-bucket PAGE breakdown (host + path) → attach to the page nodes (col ≥ 1).
  // Remap each raw page-type through the SAME top-5 fold the flow uses (cat), so a
  // node like "Other" lists the pages from every folded-away category too, and the
  // same page is merged when two categories fold together.
  const byBucket = new Map<string, Map<string, number>>();
  for (const r of pageBdRows ?? []) {
    const folded = cat(String(r[0] || "")); // '' → skip
    if (!folded) continue;
    const page = String(r[1] || "(unknown)");
    const m = byBucket.get(folded) ?? new Map<string, number>();
    m.set(page, (m.get(page) ?? 0) + Number(r[2] || 0));
    byBucket.set(folded, m);
  }
  const foldPages = (m?: Map<string, number>) => {
    if (!m) return [];
    const arr = [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    if (arr.length <= 40) return arr;
    const rest = arr.slice(40).reduce((a, b) => a + b.value, 0);
    return [...arr.slice(0, 40), { label: `+${arr.length - 40} more pages`, value: rest }];
  };
  for (const n of nodes) if (n.col >= 1) n.breakdown = foldPages(byBucket.get(n.label));

  const links: FlowLink[] = [];
  for (const [k, v] of l01) { const [a, b] = k.split("|||"); links.push({ source: `0:${a}`, target: `1:${b}`, value: v }); }
  for (const [k, v] of l12) { const [a, b] = k.split("|||"); links.push({ source: `1:${a}`, target: `2:${b}`, value: v }); }
  for (const [k, v] of l23) { const [a, b] = k.split("|||"); links.push({ source: `2:${a}`, target: `3:${b}`, value: v }); }

  return { nodes, links, sessions };
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function getWebMetrics(daysRaw = 30, fromRaw?: string, toRaw?: string, humansOnly = true, flowPages?: string[], flowMatch?: string): Promise<WebMetrics> {
  const from = isDate(fromRaw);
  const to = isDate(toRaw);
  let days = Math.max(1, Math.min(365, Math.round(daysRaw || 30)));
  let since: string;
  let label: string;
  if (from && to && from <= to) {
    since = `timestamp >= toDateTime('${from} 00:00:00') AND timestamp <= toDateTime('${to} 23:59:59')`;
    label = `${from} → ${to}`;
    days = Math.max(1, Math.min(366, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1));
  } else {
    since = `timestamp >= now() - INTERVAL ${days} DAY`;
    label = `last ${days} days`;
  }
  // Production website only: real hosts are the apex bhomes.com or a *.bhomes.com
  // subdomain (www, eos…). This drops the ~99 Vercel preview/staging deploys
  // (*.vercel.app) and any other non-production host that reports into this
  // PostHog project. Applied to every query below (they all interpolate ${since}),
  // including the journey flow.
  since += ` AND (lower(properties.$host) = 'bhomes.com' OR lower(properties.$host) LIKE '%.bhomes.com')`;

  // Resolve the range on the server so the client never derives dates itself —
  // a `new Date()` in a useState initialiser renders differently on server and
  // client and trips hydration.
  const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
  const resolvedTo = from && to && from <= to ? to : ymdOf(new Date());
  const resolvedFrom = from && to && from <= to ? from : ymdOf(new Date(Date.now() - (days - 1) * 864e5));

  const key = process.env.POSTHOG_API_KEY;
  const base: WebMetrics = { connected: !!key, hasData: false, humansOnly, days, label, from: resolvedFrom, to: resolvedTo, generatedAt: new Date().toISOString(), overview: null, bots: { pageviews: 0, pct: 0 }, trend: [], topPages: [], sources: [], countries: [], flow: { nodes: [], links: [], sessions: 0 } };
  if (!key) return base;

  const pv = `event = '$pageview'`;
  const dc = DATACENTER_CITIES.map((c) => `'${c}'`).join(", ");
  // A hit is "automated" if PostHog flagged it, OR it's from a cloud datacenter
  // city, OR it runs desktop Linux. Real consumers are ~98% Windows/Mac/iOS/
  // Android; near-100%-Linux traffic (the China / Singapore / Hong Kong /
  // Netherlands server traffic, each ~1.0 pageviews/session) is bots/crawlers.
  const botExpr = `(coalesce(properties.$virt_is_bot, false) = true OR properties.$geoip_city_name IN (${dc}) OR properties.$os = 'Linux')`;
  const human = humansOnly ? ` AND NOT ${botExpr}` : "";
  const organic = SEARCH_ENGINES.map((e) => `properties.$referring_domain LIKE '%${e}%'`).join(" OR ");

  const [ov, tr, tp, sr, co, fl] = await Promise.all([
    hogql(
      `SELECT count() AS all_pv, count(DISTINCT person_id) AS all_vis, count(DISTINCT properties.$session_id) AS all_sess, ` +
        `count(DISTINCT if(${organic}, properties.$session_id, NULL)) AS all_org, ` +
        `countIf(NOT ${botExpr}) AS h_pv, count(DISTINCT if(NOT ${botExpr}, person_id, NULL)) AS h_vis, ` +
        `count(DISTINCT if(NOT ${botExpr}, properties.$session_id, NULL)) AS h_sess, ` +
        `count(DISTINCT if(NOT ${botExpr} AND (${organic}), properties.$session_id, NULL)) AS h_org, ` +
        `countIf(${botExpr}) AS bot_pv ` +
        `FROM events WHERE ${pv} AND ${since}`,
    ),
    hogql(`SELECT toDate(timestamp) AS day, count() AS pageviews, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} GROUP BY day ORDER BY day`),
    hogql(`SELECT properties.$pathname AS path, count() AS views FROM events WHERE ${pv} AND ${since}${human} AND properties.$pathname != '' GROUP BY path ORDER BY views DESC LIMIT 12`),
    hogql(`SELECT coalesce(nullif(nullif(properties.$referring_domain, ''), '$direct'), 'Direct / none') AS source, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE ${pv} AND ${since}${human} GROUP BY source ORDER BY sessions DESC LIMIT 10`),
    hogql(`SELECT properties.$geoip_country_name AS country, count(DISTINCT person_id) AS visitors FROM events WHERE ${pv} AND ${since}${human} AND properties.$geoip_country_name != '' GROUP BY country ORDER BY visitors DESC LIMIT 10`),
    getUserFlow(since, human, flowPages, flowMatch === "exact"),
  ]);

  const row = ov && ov[0];
  const all = row ? { pageviews: Number(row[0] || 0), visitors: Number(row[1] || 0), sessions: Number(row[2] || 0), organic: Number(row[3] || 0) } : null;
  const humans = row ? { pageviews: Number(row[4] || 0), visitors: Number(row[5] || 0), sessions: Number(row[6] || 0), organic: Number(row[7] || 0) } : null;
  const botPv = row ? Number(row[8] || 0) : 0;
  const overview = humansOnly ? humans : all;
  const botPct = all && all.pageviews ? Math.round((botPv / all.pageviews) * 100) : 0;

  return {
    connected: true,
    hasData: !!(all && all.pageviews > 0),
    humansOnly,
    days,
    label,
    from: resolvedFrom,
    to: resolvedTo,
    generatedAt: new Date().toISOString(),
    overview,
    bots: { pageviews: botPv, pct: botPct },
    trend: (tr ?? []).map((r) => ({ day: String(r[0]), pageviews: Number(r[1] || 0), visitors: Number(r[2] || 0) })),
    topPages: (tp ?? []).map((r) => ({ path: String(r[0] || "/"), views: Number(r[1] || 0) })),
    sources: (sr ?? []).map((r) => ({ source: String(r[0] || "Direct / none"), sessions: Number(r[1] || 0) })),
    countries: (co ?? []).map((r) => ({ country: String(r[0] || "—"), visitors: Number(r[1] || 0) })),
    flow: fl ?? { nodes: [], links: [], sessions: 0 },
  };
}

// ── SEO tab: traffic by channel + AI sessions (by source) + organic pageviews ──
// Same entry-source classification as the journey Sankey, but aggregated as
// per-channel pageviews & sessions (production hosts + humans only).
function channelClassify(ref: string): string {
  return (
    `multiIf(` +
    `${ref} = '' OR ${ref} = '$direct' OR ${ref} LIKE '%bhomes.com%', 'Direct', ` +
    `${ref} LIKE '%chatgpt.%' OR ${ref} LIKE '%openai.%' OR ${ref} LIKE '%perplexity.%' OR ${ref} LIKE '%claude.%' OR ${ref} LIKE '%gemini.google%' OR ${ref} LIKE '%copilot.%', 'AI Assistant', ` +
    `${ref} LIKE '%google.%' OR ${ref} LIKE '%bing.%' OR ${ref} LIKE '%yahoo.%' OR ${ref} LIKE '%duckduckgo.%' OR ${ref} LIKE '%ecosia.%' OR ${ref} LIKE '%yandex.%' OR ${ref} LIKE '%baidu.%' OR ${ref} LIKE '%brave.%', 'Organic Search', ` +
    `${ref} LIKE '%facebook.%' OR ${ref} LIKE '%instagram.%' OR ${ref} LIKE '%linkedin.%' OR ${ref} = 't.co' OR ${ref} LIKE '%youtube.%' OR ${ref} LIKE '%tiktok.%', 'Social', ` +
    `'Referral')`
  );
}

export interface SeoTraffic {
  connected: boolean;
  label: string;
  totalPageviews: number;
  organicPageviews: number;
  aiSessions: number;
  totalSessions: number;
  byChannel: { channel: string; pageviews: number; sessions: number }[];
  aiBySource: { source: string; sessions: number }[];
  /** byChannel came from entry-level attribution, not the per-session pass. */
  approxChannels?: boolean;
  error?: string;
}

export async function getSeoTraffic(fromRaw?: string, toRaw?: string, daysRaw = 30): Promise<SeoTraffic> {
  const key = process.env.POSTHOG_API_KEY;
  const from = isDate(fromRaw);
  const to = isDate(toRaw);
  const days = Math.max(1, Math.min(365, Math.round(daysRaw || 30)));
  let since: string;
  let label: string;
  if (from && to && from <= to) {
    since = `timestamp >= toDateTime('${from} 00:00:00') AND timestamp <= toDateTime('${to} 23:59:59')`;
    label = `${from} → ${to}`;
  } else {
    since = `timestamp >= now() - INTERVAL ${days} DAY`;
    label = `last ${days} days`;
  }
  since += ` AND (lower(properties.$host) = 'bhomes.com' OR lower(properties.$host) LIKE '%.bhomes.com')`;
  const base: SeoTraffic = { connected: !!key, label, totalPageviews: 0, organicPageviews: 0, aiSessions: 0, totalSessions: 0, byChannel: [], aiBySource: [] };
  if (!key) return base;

  const dc = DATACENTER_CITIES.map((c) => `'${c}'`).join(", ");
  const human = ` AND NOT (coalesce(properties.$virt_is_bot, false) = true OR properties.$geoip_city_name IN (${dc}) OR properties.$os = 'Linux')`;
  const chan = channelClassify("ref");
  // HEAVY: one per-session pass (argMin first referrer) → channel pageviews &
  // sessions. Given extra time so a large range isn't cut off (this is the only
  // heavy scan, so it won't contend with the AI query below).
  const inner = `SELECT properties.$session_id AS sid, argMin(coalesce(properties.$referring_domain, ''), timestamp) AS ref, count() AS pv FROM events WHERE event = '$pageview' AND ${since}${human} AND properties.$session_id != '' GROUP BY sid`;
  // LIGHT: AI sessions by LLM referrer, filtered at the event level (no
  // per-session pass) — cheap and independent of the heavy query. LLM referrers
  // only appear on the entry pageview, so this ≈ first-referrer attribution.
  const aiRefEvent = `(properties.$referring_domain LIKE '%chatgpt.%' OR properties.$referring_domain LIKE '%openai.%' OR properties.$referring_domain LIKE '%perplexity.%' OR properties.$referring_domain LIKE '%claude.%' OR properties.$referring_domain LIKE '%gemini.google%' OR properties.$referring_domain LIKE '%copilot.%')`;

  const organicRef = SEARCH_ENGINES.map((e) => `properties.$referring_domain LIKE '%${e}%'`).join(" OR ");
  const [chanRows, aiRows, totalRows] = await Promise.all([
    // best-effort: per-session channel breakdown (powers the "by channel" chart)
    hogql(`SELECT ${chan} AS channel, sum(pv) AS pageviews, count() AS sessions FROM (${inner}) GROUP BY channel ORDER BY pageviews DESC`, 25000),
    // cheap: AI sessions by LLM referrer
    hogql(`SELECT properties.$referring_domain AS ref, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE event = '$pageview' AND ${since}${human} AND ${aiRefEvent} GROUP BY ref ORDER BY sessions DESC LIMIT 20`),
    // cheap + GUARANTEED: headline totals in a single scan (no per-session pass),
    // so the KPIs are always populated even if the channel breakdown times out.
    hogql(`SELECT count() AS total, countIf(${organicRef}) AS organic, count(DISTINCT properties.$session_id) AS sessions FROM events WHERE event = '$pageview' AND ${since}${human}`),
  ]);

  for (const r of chanRows ?? []) {
    const ch = String(r[0] || "");
    base.byChannel.push({ channel: ch, pageviews: Number(r[1] || 0), sessions: Number(r[2] || 0) });
    if (ch === "Organic Search") base.organicPageviews = Number(r[1] || 0); // session-attributed (preferred)
  }
  base.aiBySource = (aiRows ?? []).map((r) => ({ source: String(r[0] || "(unknown)"), sessions: Number(r[1] || 0) }));

  // Headline numbers come from the guaranteed cheap query (never 0 when data exists).
  const tr = totalRows?.[0];
  if (tr) {
    base.totalPageviews = Number(tr[0] || 0);
    base.totalSessions = Number(tr[2] || 0);
    if (!base.organicPageviews) base.organicPageviews = Number(tr[1] || 0); // fallback if the channel scan didn't return
  }
  const aiNode = base.byChannel.find((c) => c.channel === "AI Assistant");
  base.aiSessions = aiNode ? aiNode.sessions : base.aiBySource.reduce((a, s) => a + s.sessions, 0);

  if (!totalRows && !chanRows) {
    base.error = "PostHog traffic query failed or timed out.";
    return base;
  }

  // The per-session pass is the only heavy scan, so it times out on its own over
  // a long range while the cheap totals still succeed. That used to leave
  // byChannel empty with no error set, and the card rendered "No pageviews in
  // range" — reporting a dead query as an absence of traffic.
  //
  // Retry at entry level instead: internal navigation carries a bhomes.com
  // referrer, so excluding it leaves ≈ the entry pageview of each session. That
  // is first-touch attribution without the GROUP BY, which is the same
  // reasoning the AI-sessions query above already relies on. Counts are entries
  // rather than all pageviews, so the caller flags the chart as approximate.
  const contradiction = base.byChannel.length === 0 && base.totalPageviews > 0;
  if (!chanRows || contradiction) {
    const entryRef = `coalesce(properties.$referring_domain, '')`;
    const entryRows = await hogql(
      `SELECT ${channelClassify(entryRef)} AS channel, count() AS entries, count(DISTINCT properties.$session_id) AS sessions ` +
        `FROM events WHERE event = '$pageview' AND ${since}${human} AND NOT (${entryRef} LIKE '%bhomes.com%') ` +
        `GROUP BY channel ORDER BY entries DESC`,
    );
    if (entryRows?.length) {
      base.byChannel = entryRows.map((r) => ({ channel: String(r[0] || ""), pageviews: Number(r[1] || 0), sessions: Number(r[2] || 0) }));
      base.approxChannels = true;
      if (!base.organicPageviews) {
        base.organicPageviews = base.byChannel.find((c) => c.channel === "Organic Search")?.pageviews ?? 0;
      }
    } else {
      base.error = "Channel breakdown timed out — try a shorter range (7 or 30 days).";
    }
  }
  return base;
}
