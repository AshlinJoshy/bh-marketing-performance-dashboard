// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) read
// from the Engage CRM via Metabase, plus the spend model that turns it into cost
// per lead and cost per deal. Server-only.
//
// This closes the gap lib/company.ts documents: "Portal spend, cost per deal and
// return on spend are deliberately absent: the CRM holds no spend data (the old
// report hardcoded it from a spreadsheet)." It still holds none — so spend is an
// INPUT here, defaulting to AED 10M a year, and every derived figure is labelled
// as an estimate rather than dressed up as measured.
//
// Definitions are inherited from lib/company.ts on purpose, so the two tabs can
// never disagree about what a lead or a deal is:
//   • Deal    — status Reserved/Closed/Completed, state <> 'Withdrawn', dated by
//               reserved_at.
//   • Revenue — final_gross_commission_amount, AED.
//   • Channel — enquiry_source of the deal's ORIGINATING lead.
//
// The listings-by-area figures are schema-DISCOVERED, not guessed: the column
// that holds a property's area differs between Engage installs, so the query is
// built from information_schema at run time and the page reports which column it
// used. Guessing a column name here would produce a query that either errors or,
// worse, silently groups by the wrong thing.
import { mbQuery, mbQueryEx } from "@/lib/metabase";

/** Portals we report individually. Anything else portal-ish surfaces in the audit. */
export const PORTALS = ["Property Finder", "Bayut", "Dubizzle"] as const;
export type Portal = (typeof PORTALS)[number];

/** Default annual portal spend, AED — the working assumption, editable in the UI. */
export const DEFAULT_ANNUAL_SPEND = 10_000_000;

export interface PortalRow {
  portal: string;
  leads: number;
  deals: number;
  commission: number;
  /** Live listings attributed to this portal, or null when the CRM doesn't record it. */
  listings: number | null;
}

export interface AreaRow {
  area: string;
  listings: number;
  /** Leads whose enquiry came from a portal and whose property sits in this area. */
  leads: number | null;
}

export interface PortalsData {
  connected: boolean;
  from: string;
  to: string;
  label: string;
  months: string[];
  portals: string[];
  brands: { key: string; label: string }[];
  brand: string;
  generatedAt: string;

  /** Per-portal totals for the window. */
  rows: PortalRow[];
  /** series[portal][monthIndex] */
  leadsByMonth: Record<string, number[]>;
  dealsByMonth: Record<string, number[]>;
  commByMonth: Record<string, number[]>;

  /** Listings grouped by area, biggest first. */
  areas: AreaRow[];
  /** Which column the area grouping came from, so the number can be checked. */
  areaSource: string | null;
  /** Set when the CRM records no per-portal listing publication. */
  listingsNote: string | null;

  /**
   * enquiry_source values that are NOT one of the known portals, with counts.
   * Present so a portal we haven't mapped (a new one, or a spelling variant)
   * shows up as a number to ask about rather than vanishing from the channel.
   */
  unmappedSources: { source: string; n: number }[];

  error?: string;
  /** Non-fatal problems — one card failing must not blank the page. */
  warnings: string[];
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function monthList(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * The portal bucket. Only the three real portals map; everything else becomes
 * NULL so it can be excluded from portal figures instead of inflating them.
 */
function portalSql(col: string): string {
  const s = `LOWER(TRIM(${col}))`;
  return `CASE
    WHEN ${s} IN ('pf','property finder','propertyfinder','property-finder') THEN 'Property Finder'
    WHEN ${s} IN ('bayut','bayut.com') THEN 'Bayut'
    WHEN ${s} IN ('dubizzle','dubizzle.com') THEN 'Dubizzle'
    END`;
}

const DEAL_VALID = `d.status IN ('Reserved','Closed','Completed') AND d.state <> 'Withdrawn'`;

function brandFilter(names: string[], col: string): string {
  if (!names.length) return "";
  return ` AND ${col} IN (SELECT id FROM divisions WHERE name IN (${names.map(sqlStr).join(",")}))`;
}

const BRAND_GROUPS: Record<string, string[]> = {
  betterhomes: ["Betterhomes", "Local", "BH Elite", "BH Exclusive"],
  prime: ["Prime"],
};

function brandNames(brand: string): string[] {
  if (BRAND_GROUPS[brand]) return BRAND_GROUPS[brand];
  if (brand.startsWith("entity:")) return [brand.slice("entity:".length)];
  return [];
}

export function portalsRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const floor = "2025-01-01";
  let to = isDate(toRaw) ?? ymd(new Date());
  let from = isDate(fromRaw) ?? floor;
  if (from < floor) from = floor;
  if (to < from) [from, to] = [to, from];
  return { from, to };
}

/**
 * Find the column that holds a property's area.
 *
 * Ordered by how specific the name is: a column called "community" is a better
 * area grouping than one called "location", which might be a full address. Only
 * text columns qualify — an *_id would group by a meaningless integer.
 */
const AREA_CANDIDATES = ["community", "sub_community", "area", "district", "neighbourhood", "neighborhood", "location", "city"];

async function discoverAreaColumn(): Promise<{ table: string; column: string } | null> {
  const sql = `
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('properties','listings')
      AND DATA_TYPE IN ('varchar','char','text','tinytext','mediumtext','enum')
    ORDER BY TABLE_NAME, ORDINAL_POSITION`;
  const rows = await mbQuery(sql, true, 15000);
  if (!rows?.length) return null;
  const cols = rows.map((r) => ({
    table: String(r[0] ?? ""),
    column: String(r[1] ?? ""),
    lc: String(r[1] ?? "").toLowerCase(),
  }));
  // Prefer `properties` (the physical thing has the area) then listings.
  for (const want of AREA_CANDIDATES) {
    for (const table of ["properties", "listings"]) {
      const hit = cols.find((c) => c.table === table && c.lc === want);
      if (hit) return { table: hit.table, column: hit.column };
    }
  }
  // Nothing matched exactly — try a contains match before giving up.
  for (const want of AREA_CANDIDATES) {
    const hit = cols.find((c) => c.lc.includes(want));
    if (hit) return { table: hit.table, column: hit.column };
  }
  return null;
}

/** Does the CRM record which portal a listing is published to? */
async function discoverPortalLinkage(): Promise<string[]> {
  const sql = `
    SELECT TABLE_NAME, COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND (LOWER(TABLE_NAME) LIKE '%portal%'
           OR LOWER(COLUMN_NAME) LIKE '%portal%'
           OR LOWER(COLUMN_NAME) LIKE '%bayut%'
           OR LOWER(COLUMN_NAME) LIKE '%dubizzle%'
           OR LOWER(COLUMN_NAME) LIKE '%propertyfinder%')
    ORDER BY TABLE_NAME, ORDINAL_POSITION
    LIMIT 60`;
  const rows = await mbQuery(sql, true, 15000);
  return (rows ?? []).map((r) => `${r[0]}.${r[1]}`);
}

export async function getPortalsData(fromRaw?: string, toRaw?: string, brandRaw?: string): Promise<PortalsData> {
  const { from, to } = portalsRange(fromRaw, toRaw);
  const months = monthList(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const brand = brandRaw && brandNames(brandRaw).length ? String(brandRaw) : "";
  const names = brandNames(brand);

  const connected = !!(
    process.env.METABASE_URL &&
    (process.env.METABASE_API_KEY || (process.env.METABASE_USERNAME && process.env.METABASE_PASSWORD))
  );

  const zero = () => Object.fromEntries(PORTALS.map((p) => [p, new Array(months.length).fill(0)])) as Record<string, number[]>;

  const base: PortalsData = {
    connected,
    from,
    to,
    label: `${from} → ${to}`,
    months,
    portals: [...PORTALS],
    brands: [
      { key: "", label: "All brands" },
      { key: "betterhomes", label: "Betterhomes" },
      { key: "prime", label: "Prime" },
    ],
    brand,
    generatedAt: new Date().toISOString(),
    rows: PORTALS.map((p) => ({ portal: p, leads: 0, deals: 0, commission: 0, listings: null })),
    leadsByMonth: zero(),
    dealsByMonth: zero(),
    commByMonth: zero(),
    areas: [],
    areaSource: null,
    listingsNote: null,
    unmappedSources: [],
    warnings: [],
  };
  if (!connected) return base;

  const until = `DATE_ADD('${to}', INTERVAL 1 DAY)`;
  const P_LEAD = portalSql("l.enquiry_source");

  const leadsSql = `
    SELECT DATE_FORMAT(l.created_at,'%Y-%m') AS mth, ${P_LEAD} AS portal, COUNT(*) AS n
    FROM leads l
    WHERE l.created_at >= '${from}' AND l.created_at < ${until}
      AND ${P_LEAD} IS NOT NULL${brandFilter(names, "l.division_id")}
    GROUP BY 1,2`;

  const dealsSql = `
    SELECT DATE_FORMAT(d.reserved_at,'%Y-%m') AS mth, ${P_LEAD} AS portal,
           COUNT(*) AS n, SUM(COALESCE(d.final_gross_commission_amount,0)) AS comm
    FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.reserved_at >= '${from}' AND d.reserved_at < ${until}
      AND ${DEAL_VALID} AND ${P_LEAD} IS NOT NULL${brandFilter(names, "d.division_id")}
    GROUP BY 1,2`;

  // Every source that ISN'T a mapped portal. Shown so an unmapped portal is a
  // visible number rather than a silent omission from the channel.
  const unmappedSql = `
    SELECT LOWER(TRIM(l.enquiry_source)) AS src, COUNT(*) AS n
    FROM leads l
    WHERE l.created_at >= '${from}' AND l.created_at < ${until}
      AND ${P_LEAD} IS NULL
      AND l.enquiry_source IS NOT NULL AND TRIM(l.enquiry_source) <> ''
      ${brandFilter(names, "l.division_id")}
    GROUP BY 1 ORDER BY 2 DESC LIMIT 25`;

  const [leadsRes, dealsRes, unmappedRows, area, portalCols] = await Promise.all([
    mbQueryEx(leadsSql, true, 30000),
    mbQueryEx(dealsSql, true, 30000),
    mbQuery(unmappedSql, true, 25000),
    discoverAreaColumn(),
    discoverPortalLinkage(),
  ]);

  const leadRows = "rows" in leadsRes ? leadsRes.rows : null;
  const dealRows = "rows" in dealsRes ? dealsRes.rows : null;

  if (!leadRows && !dealRows) {
    return {
      ...base,
      error: `Metabase didn't return portal figures — ${"error" in leadsRes ? leadsRes.error : "unknown"}`,
    };
  }
  if (!leadRows) base.warnings.push(`Lead counts unavailable (${"error" in leadsRes ? leadsRes.error : "failed"}) — deals and commission are still live.`);
  if (!dealRows) base.warnings.push(`Deal and commission figures unavailable (${"error" in dealsRes ? dealsRes.error : "failed"}) — lead counts are still live.`);

  const totals = new Map<string, PortalRow>(base.rows.map((r) => [r.portal, { ...r }]));

  for (const r of leadRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const p = String(r[1] ?? "");
    if (i === undefined || !base.leadsByMonth[p]) continue;
    const n = Number(r[2] ?? 0);
    base.leadsByMonth[p][i] += n;
    totals.get(p)!.leads += n;
  }
  for (const r of dealRows ?? []) {
    const i = idx.get(String(r[0] ?? ""));
    const p = String(r[1] ?? "");
    if (i === undefined || !base.dealsByMonth[p]) continue;
    const n = Number(r[2] ?? 0);
    const c = Number(r[3] ?? 0);
    base.dealsByMonth[p][i] += n;
    base.commByMonth[p][i] += c;
    totals.get(p)!.deals += n;
    totals.get(p)!.commission += c;
  }

  base.unmappedSources = (unmappedRows ?? []).map((r) => ({ source: String(r[0] ?? ""), n: Number(r[1] ?? 0) }));

  // ── listings by area ────────────────────────────────────────────
  if (area) {
    base.areaSource = `${area.table}.${area.column}`;
    const col = `\`${area.table}\`.\`${area.column}\``;
    // Count listings of properties, grouped by the discovered area column.
    // listable_type = 'Property' mirrors lib/company.ts's join.
    const areaSql = `
      SELECT COALESCE(NULLIF(TRIM(${col}), ''), '(no area)') AS area, COUNT(*) AS n
      FROM listings li
      ${area.table === "properties" ? "JOIN properties ON properties.id = li.listable_id AND li.listable_type = 'Property'" : ""}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 60`;
    const areaRows = await mbQuery(areaSql, true, 30000);
    if (areaRows) {
      base.areas = areaRows.map((r) => ({ area: String(r[0] ?? ""), listings: Number(r[1] ?? 0), leads: null }));
    } else {
      base.warnings.push(`Listings by area unavailable — the grouped query on ${base.areaSource} failed or timed out.`);
    }
  } else {
    base.warnings.push("Couldn't find an area/community column on properties or listings, so listings by area is empty.");
  }

  // Per-portal listing counts only exist if the CRM records publication.
  if (!portalCols.length) {
    base.listingsNote =
      "The CRM records no per-portal publication field, so listings can't be split by portal — the area figures are total live listings, not per portal.";
  } else {
    base.listingsNote = `Possible portal fields found (${portalCols.slice(0, 6).join(", ")}) — not wired in yet; confirm which one marks publication and it can be split per portal.`;
  }

  base.rows = [...totals.values()];
  return base;
}

// ── spend model (client-side too, so the UI can recompute live) ────

export interface SpendModel {
  /** Annual portal spend in AED across all portals. */
  annual: number;
  /** Share of spend per portal, 0-1. Missing portals split what's left evenly. */
  split: Record<string, number>;
}

/**
 * Spend for the window, pro-rated from the annual figure by month count.
 *
 * Pro-rating is what keeps cost per lead comparable across date ranges: a
 * three-month view charged with a whole year's spend would read as three times
 * the true cost per lead.
 */
export function spendForPeriod(annual: number, monthCount: number): number {
  if (!Number.isFinite(annual) || annual <= 0 || monthCount <= 0) return 0;
  return annual * (monthCount / 12);
}

/**
 * Default allocation: by share of leads, because that's the only portal-relative
 * volume the CRM actually gives us. Portal invoices are really driven by listing
 * credits, so this is an assumption — surfaced and editable, not hidden.
 */
export function defaultSplit(rows: PortalRow[]): Record<string, number> {
  const total = rows.reduce((s, r) => s + r.leads, 0);
  if (!total) {
    const even = rows.length ? 1 / rows.length : 0;
    return Object.fromEntries(rows.map((r) => [r.portal, even]));
  }
  return Object.fromEntries(rows.map((r) => [r.portal, r.leads / total]));
}
