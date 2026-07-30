// Real portal spend, from the PPA workbook (Portal Performance Analysis).
//
// PROVENANCE — the `expense` sheet of PPA.xlsx, a monthly spend schedule in AED
// covering Jan 2025 → Mar 2026. Only SPEND is taken from that workbook: deal
// counts, commission and applicants all come from the CRM, so the two can't
// drift apart and the workbook's own derived columns are never trusted.
//
// The figures reconcile against the workbook's own Pivot totals to the dirham,
// which is why they're used rather than an assumption:
//   Property Finder  sum = 10,632,602  (Pivot "Portal Spent" = 10,632,602) ✓
//   Bayut            sum =  2,854,076  (Pivot "Portal Spent" =  2,854,076) ✓
//
// Dubizzle has NO monthly column in that sheet — only a Pivot total of 300,019
// for the same period. It's carried as a total and averaged over the same 15
// months, which is an assumption about its shape, not its size. Flagged in the
// UI so it isn't read as a measured monthly series.
//
// Note on the workbook: its Pivot reports two different cost-per-deal figures
// for Dubizzle (13,647.22 and 1,666.77) from one spend and one deal count —
// 300,019 / 180 = 1,666.77, so the larger one is a formula error. Another reason
// to recompute cost per deal here from live CRM deals rather than import it.

/** Monthly spend in AED, indexed by "YYYY-MM". */
export type SpendSeries = Record<string, number>;

const MONTHS = [
  "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08",
  "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
];

const series = (vals: number[]): SpendSeries =>
  Object.fromEntries(MONTHS.map((m, i) => [m, vals[i] ?? 0]));

/** Property Finder — three months at the old rate, an April spike, then flat. */
const PROPERTY_FINDER = series([
  429342, 429342, 429342, 898248, 767848, 767848, 767848, 767848,
  767848, 767848, 767848, 767848, 767848, 767848, 767848,
]);

/** Bayut — two rate changes, then flat from June 2025. */
const BAYUT = series([
  134663, 134663, 128250, 128250, 128250, 220000, 220000, 220000,
  220000, 220000, 220000, 220000, 220000, 220000, 220000,
]);

/** Dubizzle — period total only, spread evenly. See the header note. */
const DUBIZZLE = series(new Array(MONTHS.length).fill(300019 / MONTHS.length));

export const PORTAL_SPEND: Record<string, SpendSeries> = {
  "Property Finder": PROPERTY_FINDER,
  Bayut: BAYUT,
  Dubizzle: DUBIZZLE,
};

/** Portals whose spend is a real monthly schedule rather than a spread total. */
export const SPEND_IS_MONTHLY: Record<string, boolean> = {
  "Property Finder": true,
  Bayut: true,
  Dubizzle: false,
};

export const SPEND_SOURCE_LABEL = "PPA.xlsx · expense sheet · Jan 2025 – Mar 2026";
export const SPEND_MONTHS = MONTHS.length;

/**
 * Average monthly spend per portal across the whole schedule.
 *
 * An average, not the month-by-month figure, because a rate is what makes the
 * page work for any date range — including months the workbook doesn't cover,
 * where a month-exact lookup would silently contribute zero and read as free.
 */
export function avgMonthlySpend(portal: string): number {
  const s = PORTAL_SPEND[portal];
  if (!s) return 0;
  const vals = Object.values(s);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/** Average monthly spend summed over every portal. */
export function avgMonthlySpendTotal(): number {
  return Object.keys(PORTAL_SPEND).reduce((s, p) => s + avgMonthlySpend(p), 0);
}

/** Spend for a window: the portal's average monthly rate times the months in view. */
export function portalSpendFor(portal: string, monthCount: number): number {
  if (monthCount <= 0) return 0;
  return avgMonthlySpend(portal) * monthCount;
}
