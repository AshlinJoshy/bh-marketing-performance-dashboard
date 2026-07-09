// Metabase (betterhomes CRM) — organic & AI leads, and their pipeline stage /
// open-closed status. Server-only.
//
// Runs native SQL against the Metabase `leads` view via the dataset API. Auth is
// either a username/password login (Metabase session) OR an API key. Set (missing
// → graceful "not connected"):
//   METABASE_URL       e.g. "https://metabase.yourco.com"
//   METABASE_USERNAME  Metabase login email  ── used together (session auth)
//   METABASE_PASSWORD  Metabase login password ─┘
//   METABASE_API_KEY   optional alternative to username/password
//   METABASE_DB_ID     the database id (defaults to 14)
//
// Lead taxonomy (confirmed against the `leads` view):
//   • AI lead      — utm.source or enquiry_source is an LLM domain (chatgpt.com…)
//   • Organic lead — enquiry_source='website' with no utm, OR a website pop-up
//   • Stage        — the `status` column (New · Qualified · … · Deal)
//   • Status       — the `state`  column (Open · Closed · Completed)
const DB_ID = Number(process.env.METABASE_DB_ID || 14);

const LLM_DOMAINS = ["chatgpt.com", "perplexity.ai", "openai.com", "gemini.google.com", "claude.ai", "copilot.microsoft.com"];

export interface LeadsData {
  connected: boolean;
  label: string;
  aiLeads: number;
  organicLeads: number;
  websiteNoUtm: number;
  popup: number;
  aiBySource: { source: string; n: number }[];
  stage: { segment: string; stage: string; n: number }[]; // pipeline (status col)
  status: { segment: string; status: string; n: number }[]; // open/closed (state col)
  error?: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// SQL fragments (reused across the queries)
const utmSource = `LOWER(JSON_UNQUOTE(JSON_EXTRACT(utm,'$.source')))`;
const utmMedium = `LOWER(JSON_UNQUOTE(JSON_EXTRACT(utm,'$.medium')))`;
const llmList = LLM_DOMAINS.map((d) => `'${d}'`).join(",");
const IS_AI = `(${utmSource} IN (${llmList}) OR LOWER(enquiry_source) IN (${llmList}))`;
const IS_POPUP = `(${utmSource} LIKE '%pop-up%' OR ${utmMedium} LIKE '%pop-up%' OR LOWER(enquiry_source) LIKE '%pop-up%')`;
const IS_WEB_NOUTM = `(LOWER(enquiry_source) = 'website' AND (utm IS NULL OR ${utmSource} IS NULL OR ${utmSource} = ''))`;
const SEG = `CASE WHEN ${IS_AI} THEN 'ai' WHEN (${IS_WEB_NOUTM} OR ${IS_POPUP}) THEN 'organic' ELSE 'other' END`;

// Session token from username/password, cached in-process and refreshed on a 401.
let mbSession: { token: string; exp: number } | null = null;

async function mbSessionToken(): Promise<string | null> {
  const url = process.env.METABASE_URL;
  const user = process.env.METABASE_USERNAME;
  const pass = process.env.METABASE_PASSWORD;
  if (!url || !user || !pass) return null;
  if (mbSession && mbSession.exp > Date.now()) return mbSession.token;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.id) return null;
    mbSession = { token: String(j.id), exp: Date.now() + 13 * 864e5 }; // tokens last ~14d
    return mbSession.token;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function mbQuery(sql: string, retry = true): Promise<any[][] | null> {
  const url = process.env.METABASE_URL;
  if (!url) return null;
  const apiKey = process.env.METABASE_API_KEY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  } else {
    const token = await mbSessionToken();
    if (!token) return null;
    headers["X-Metabase-Session"] = token;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/dataset`, {
      method: "POST",
      headers,
      body: JSON.stringify({ database: DB_ID, type: "native", native: { query: sql } }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (res.status === 401 && !apiKey && retry) {
      mbSession = null; // expired session — re-auth once
      clearTimeout(t);
      return mbQuery(sql, false);
    }
    if (!res.ok) return null;
    const j = await res.json();
    return (j?.data?.rows as any[][]) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getLeadsData(fromRaw: string, toRaw: string): Promise<LeadsData> {
  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );
  const label = `${fromRaw} → ${toRaw}`;
  const base: LeadsData = { connected, label, aiLeads: 0, organicLeads: 0, websiteNoUtm: 0, popup: 0, aiBySource: [], stage: [], status: [] };
  if (!connected) return base;
  if (!isDate(fromRaw) || !isDate(toRaw)) return { ...base, error: "bad date range" };
  const range = `created_at >= '${fromRaw} 00:00:00' AND created_at <= '${toRaw} 23:59:59'`;

  const [segRows, srcRows, stageRows, statusRows] = await Promise.all([
    // finer segment split: ai / website(no utm) / popup / other
    mbQuery(
      `SELECT sub, count(*) n FROM (SELECT CASE WHEN ${IS_AI} THEN 'ai' WHEN ${IS_WEB_NOUTM} THEN 'website' WHEN ${IS_POPUP} THEN 'popup' ELSE 'other' END sub FROM leads WHERE ${range}) t GROUP BY sub`,
    ),
    mbQuery(
      `SELECT COALESCE(NULLIF(${utmSource}, ''), LOWER(enquiry_source)) src, count(*) n FROM leads WHERE ${range} AND ${IS_AI} GROUP BY src ORDER BY n DESC`,
    ),
    mbQuery(
      `SELECT seg, CAST(status AS CHAR) stage, count(*) n FROM (SELECT status, ${SEG} seg FROM leads WHERE ${range}) t WHERE seg IN ('ai','organic') GROUP BY seg, stage ORDER BY seg, n DESC`,
    ),
    mbQuery(
      `SELECT seg, CAST(state AS CHAR) st, count(*) n FROM (SELECT state, ${SEG} seg FROM leads WHERE ${range}) t WHERE seg IN ('ai','organic') GROUP BY seg, st ORDER BY seg, n DESC`,
    ),
  ]);

  // If the very first query failed outright, report not-really-connected.
  if (!segRows) return { ...base, error: "Metabase query failed — check METABASE_URL / METABASE_API_KEY / DB access." };

  for (const r of segRows) {
    const sub = String(r[0] ?? "");
    const n = Number(r[1] ?? 0);
    if (sub === "ai") base.aiLeads = n;
    else if (sub === "website") base.websiteNoUtm = n;
    else if (sub === "popup") base.popup = n;
  }
  base.organicLeads = base.websiteNoUtm + base.popup;
  base.aiBySource = (srcRows ?? []).map((r) => ({ source: String(r[0] ?? "(unknown)"), n: Number(r[1] ?? 0) }));
  base.stage = (stageRows ?? []).map((r) => ({ segment: String(r[0] ?? ""), stage: String(r[1] ?? ""), n: Number(r[2] ?? 0) }));
  base.status = (statusRows ?? []).map((r) => ({ segment: String(r[0] ?? ""), status: String(r[1] ?? ""), n: Number(r[2] ?? 0) }));
  return base;
}
