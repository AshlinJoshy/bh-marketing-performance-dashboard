// Google Search Console (Search Analytics) — organic clicks, impressions, CTR,
// average position, and per-keyword rankings. Server-only.
//
// Auth is a Google service account (no user OAuth): sign a JWT with the account's
// private key, exchange it for an access token, then call the Search Analytics
// API. Set three env vars (all optional — missing → a graceful "not connected"):
//   GSC_SITE_URL     e.g. "sc-domain:bhomes.com"  (defaults to that)
//   GSC_CLIENT_EMAIL the service account email
//   GSC_PRIVATE_KEY  the service account private key ("\n" escapes are handled)
// The service account must be added as a user on the GSC property.
import crypto from "node:crypto";

const SITE = process.env.GSC_SITE_URL || "sc-domain:bhomes.com";

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number; // 0..1
  position: number; // avg position (lower = better)
}
export interface GscKeyword {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null; // null = not ranking / no data in range
}
export interface GscData {
  connected: boolean;
  totals: GscTotals | null;
  keywords: GscKeyword[];
  label: string;
  error?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Cache the access token in-process for its lifetime (~1h) to avoid re-signing.
let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string | null> {
  const email = process.env.GSC_CLIENT_EMAIL;
  let key = process.env.GSC_PRIVATE_KEY;
  if (!email || !key) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;
  key = key.replace(/\\n/g, "\n");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claim}`;
  let signature: string;
  try {
    signature = b64url(crypto.createSign("RSA-SHA256").update(signingInput).sign(key));
  } catch {
    return null; // malformed private key
  }
  const jwt = `${signingInput}.${signature}`;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[gsc] token HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    const j = await res.json();
    if (!j?.access_token) return null;
    tokenCache = { token: j.access_token as string, exp: now + Number(j.expires_in || 3600) };
    return tokenCache.token;
  } catch (e) {
    console.error(`[gsc] token error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function gscQuery(body: Record<string, unknown>): Promise<any | null> {
  const token = await accessToken();
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      console.error(`[gsc] searchAnalytics HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error(`[gsc] searchAnalytics error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Organic totals + per-keyword rankings, from whichever backend can answer.
 *
 * Supermetrics is tried first when its key is set, because it needs no Google
 * Cloud setup. It FALLS BACK to the Google service account, which talks to
 * Search Console directly and has no Supermetrics row quota.
 *
 * The fallback exists because preferring Supermetrics unconditionally meant a
 * spent row quota (HTTP 429 API_ROW_QUOTA_EXCEEDED) took the whole tab down for
 * the rest of the quota period, while a perfectly good second backend sat
 * implemented and unreachable. Either source alone is enough to render the tab.
 */
export async function getGscMetrics(from: string, to: string, targetKeywords: string[] = []): Promise<GscData> {
  const hasServiceAccount = !!(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY);

  if (process.env.SUPERMETRICS_API_KEY) {
    const sm = await getGscViaSupermetrics(from, to, targetKeywords);
    // A usable answer: no error AND a figure that isn't a placeholder zero.
    const usable = !sm.error && !!sm.totals && (sm.totals.impressions > 0 || sm.totals.clicks > 0);
    if (usable || !hasServiceAccount) {
      // Nothing to fall back to — say why the tab is empty rather than implying
      // Supermetrics is the only way to read Search Console.
      if (!usable && !hasServiceAccount && sm.error) {
        sm.error = `${sm.error} — no GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY set, so there is no direct Search Console fallback.`;
      }
      return sm;
    }
    const direct = await getGscViaServiceAccount(from, to, targetKeywords);
    // Only prefer the fallback if it actually produced something; otherwise keep
    // the Supermetrics message, which is the more specific of the two.
    if (!direct.error) return { ...direct, error: undefined };
    return { ...direct, error: `Supermetrics: ${sm.error} · Direct: ${direct.error}` };
  }

  return getGscViaServiceAccount(from, to, targetKeywords);
}

async function getGscViaServiceAccount(from: string, to: string, targetKeywords: string[] = []): Promise<GscData> {
  const connected = !!(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY);
  const base: GscData = { connected, totals: null, keywords: [], label: `${from} → ${to}` };
  if (!connected) return base;

  const [totalsRes, kwRes] = await Promise.all([
    gscQuery({ startDate: from, endDate: to, dimensions: [], dataState: "all" }),
    targetKeywords.length
      // Filtered server-side to the tracked terms, same reasoning as the
      // Supermetrics path: fetching every query to keep twenty is wasteful, and
      // Search Console caps rowLimit anyway.
      ? gscQuery({
          startDate: from,
          endDate: to,
          dimensions: ["query"],
          rowLimit: Math.max(25, targetKeywords.length * 3),
          dataState: "all",
          dimensionFilterGroups: [
            {
              groupType: "or",
              filters: targetKeywords.map((k) => ({ dimension: "query", operator: "equals", expression: k })),
            },
          ],
        })
      : Promise.resolve(null),
  ]);

  const row = totalsRes?.rows?.[0];
  if (!totalsRes) base.error = `GSC auth or query failed — check GSC_CLIENT_EMAIL / GSC_PRIVATE_KEY and that the service account is a user on ${SITE}.`;
  base.totals = row
    ? { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  if (targetKeywords.length) {
    const byQ = new Map<string, any>();
    for (const r of kwRes?.rows ?? []) byQ.set(String(r.keys?.[0] || "").toLowerCase(), r);
    base.keywords = targetKeywords.map((k) => {
      const r = byQ.get(k.trim().toLowerCase());
      return {
        keyword: k,
        clicks: r?.clicks || 0,
        impressions: r?.impressions || 0,
        ctr: r?.ctr || 0,
        position: r ? Math.round((r.position || 0) * 10) / 10 : null,
      };
    });
  }
  return base;
}

// ── Supermetrics Data Fetching API backend ──────────────────────
// Uses your Supermetrics API key so GSC is pulled through Supermetrics (which
// already has the property authorized) instead of a Google service account.
//   SUPERMETRICS_API_KEY   the Data Fetching API key (hub.supermetrics.com)
//   SUPERMETRICS_DS_USER   optional. The Supermetrics login that authorised GSC.
//                          OMITTED when unset rather than defaulted: this key's
//                          own account is already authorised for GSC (proven by
//                          a bare query returning data), and sending a ds_user
//                          the API key doesn't own answers 403
//                          QUERY_AUTH_UNAVAILABLE. lib/paid.ts hit exactly this
//                          and omits it for the same reason.
//   GSC_SITE_URL           the GSC account/site (defaults to sc-domain:bhomes.com)
//   SUPERMETRICS_API_URL   override the endpoint if your plan differs
const SM_ENDPOINT = process.env.SUPERMETRICS_API_URL || "https://api.supermetrics.com/enterprise/v2/query/data/json";

function smNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
const smCtr = (v: number) => (v > 1 ? v / 100 : v); // normalize % → fraction

// Supermetrics /data/json returns a 2-D array with a header row first.
function smSplit(rows: any[][] | null): { header: string[]; data: any[][] } {
  if (!rows || !rows.length) return { header: [], data: [] };
  const first = rows[0].map((x) => String(x).toLowerCase());
  const isHeader = first.some((s) => s.includes("click") || s.includes("impress") || s.includes("query") || s.includes("search") || s.includes("position") || s.includes("ctr"));
  return isHeader ? { header: rows[0].map(String), data: rows.slice(1) } : { header: [], data: rows };
}
function smIdx(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const s = String(h).toLowerCase();
    if (idx.query === undefined && (s.includes("query") || s.includes("search"))) idx.query = i;
    if (idx.clicks === undefined && s.includes("click")) idx.clicks = i;
    if (idx.impressions === undefined && s.includes("impress")) idx.impressions = i;
    if (idx.ctr === undefined && s.includes("ctr")) idx.ctr = i;
    if (idx.position === undefined && s.includes("position")) idx.position = i;
  });
  return idx;
}

/** Last failure from smQuery, so the UI can show the reason instead of a guess. */
let smLastError: string | null = null;

/**
 * Short lived cache of successful GSC reads, keyed by range and keyword set.
 *
 * Row quota is consumed per request, so a page reload used to cost as much as
 * the first load. GSC data is daily and lags two to three days, so serving a
 * result up to 30 minutes old costs nothing in accuracy and takes repeat views
 * to zero rows.
 *
 * In process, so it is per serverless instance rather than global. That is fine
 * for the purpose: it removes the reload-and-refresh pattern that drains the
 * quota, without pretending to be shared state.
 */
const GSC_TTL_MS = Number(process.env.GSC_CACHE_MS || 30 * 60 * 1000);
const gscCache = new Map<string, { at: number; data: GscData }>();

async function smQuery(fields: string[], from: string, to: string, maxRows: number, filters?: string): Promise<any[][] | null> {
  const key = process.env.SUPERMETRICS_API_KEY;
  if (!key) {
    smLastError = "SUPERMETRICS_API_KEY is not set";
    return null;
  }
  // Documented v2 method: POST JSON with `Authorization: Bearer <key>`, fields as
  // a comma-separated string. (The api_key is NOT put in the body.)
  const payload: Record<string, unknown> = {
    ds_id: "GW",
    ds_accounts: [process.env.GSC_SITE_URL || "sc-domain:bhomes.com"],
    date_range_type: "custom",
    start_date: from,
    end_date: to,
    fields: fields.join(","),
    max_rows: maxRows,
  };
  const dsUser = process.env.SUPERMETRICS_DS_USER;
  if (dsUser) payload.ds_user = dsUser;
  if (filters) payload.filters = filters;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(SM_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      smLastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      console.error(`[gsc/supermetrics] ${smLastError}`);
      return null;
    }
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      smLastError = `non-JSON response: ${text.slice(0, 160)}`;
      console.error(`[gsc/supermetrics] ${smLastError}`);
      return null;
    }
    if (j?.error) {
      const m = typeof j.error === "string" ? j.error : j.error?.message || JSON.stringify(j.error);
      smLastError = String(m).slice(0, 240);
      console.error(`[gsc/supermetrics] API error: ${smLastError}`);
      return null;
    }
    // Envelope is usually { data: [[header],[row]…] }; tolerate { data: { data: [...] } }.
    let rows: any = j?.data;
    if (rows && !Array.isArray(rows) && Array.isArray(rows.data)) rows = rows.data;
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    smLastError = m.includes("abort") ? `timed out after ${Math.round(20000 / 1000)}s` : m;
    console.error(`[gsc/supermetrics] error: ${smLastError}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getGscViaSupermetrics(from: string, to: string, targetKeywords: string[] = []): Promise<GscData> {
  const base: GscData = { connected: true, totals: null, keywords: [], label: `${from} → ${to}` };

  const cacheKey = `${from}|${to}|${targetKeywords.join("~")}`;
  const hit = gscCache.get(cacheKey);
  if (hit && Date.now() - hit.at < GSC_TTL_MS) return hit.data;

  /**
   * Filter to the tracked keywords AT THE SOURCE.
   *
   * This used to request 5,000 rows of every search query and then keep only the
   * handful in targetKeywords — roughly a 250x overfetch, repeated on every page
   * load, which is what exhausted the row quota (HTTP 429
   * API_ROW_QUOTA_EXCEEDED). The `[]` in-list operator returns one row per
   * keyword instead, verified against the live API.
   *
   * Keywords containing a comma are left out of the filter: the list operator is
   * comma-delimited with no documented escape, so including one would silently
   * split it into two wrong terms. They are reported as having no data rather
   * than corrupting the whole query.
   */
  const filterable = targetKeywords.filter((k) => !k.includes(","));
  const kwFilter = filterable.length ? `query [] ${filterable.join(",")}` : undefined;
  // A small multiple, not the exact count: GSC can return case or spacing
  // variants of the same term, and truncating those would undercount a keyword.
  const kwRowCap = Math.max(10, filterable.length * 3);

  const [totRows, kwRows] = await Promise.all([
    smQuery(["clicks", "impressions", "ctr", "position"], from, to, 1),
    kwFilter ? smQuery(["query", "clicks", "impressions", "ctr", "position"], from, to, kwRowCap, kwFilter) : Promise.resolve(null),
  ]);

  // Say what actually failed. The old text guessed at three causes and led with
  // the API key, which sent readers to check a key that was fine.
  if (!totRows) {
    base.error = smLastError
      ? `GSC via Supermetrics failed: ${smLastError}`
      : `Supermetrics returned no rows for ${process.env.GSC_SITE_URL || "sc-domain:bhomes.com"} in this range.`;
  }
  const tot = smSplit(totRows);
  if (tot.data.length) {
    const i = tot.header.length ? smIdx(tot.header) : { clicks: 0, impressions: 1, ctr: 2, position: 3 };
    const r = tot.data[tot.data.length - 1];
    base.totals = {
      clicks: smNum(r[i.clicks ?? 0]),
      impressions: smNum(r[i.impressions ?? 1]),
      ctr: smCtr(smNum(r[i.ctr ?? 2])),
      position: smNum(r[i.position ?? 3]),
    };
  } else {
    base.totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  }

  if (targetKeywords.length) {
    const kw = smSplit(kwRows);
    const i = kw.header.length ? smIdx(kw.header) : { query: 0, clicks: 1, impressions: 2, ctr: 3, position: 4 };
    const byQ = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
    for (const r of kw.data) {
      const q = String(r[i.query ?? 0] ?? "").toLowerCase();
      if (!q) continue;
      byQ.set(q, {
        clicks: smNum(r[i.clicks ?? 1]),
        impressions: smNum(r[i.impressions ?? 2]),
        ctr: smCtr(smNum(r[i.ctr ?? 3])),
        position: smNum(r[i.position ?? 4]),
      });
    }
    base.keywords = targetKeywords.map((k) => {
      const r = byQ.get(k.trim().toLowerCase());
      return {
        keyword: k,
        clicks: r?.clicks || 0,
        impressions: r?.impressions || 0,
        ctr: r?.ctr || 0,
        position: r ? Math.round((r.position || 0) * 10) / 10 : null,
      };
    });
  }
  // Only cache a good read. Caching a failure would pin the error in place for
  // the whole TTL, including after quota resets.
  if (!base.error) gscCache.set(cacheKey, { at: Date.now(), data: base });
  return base;
}
