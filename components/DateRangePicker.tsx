"use client";

import { useState } from "react";

/**
 * The one date control every tab shares — a Google-Ads-style dropdown of named
 * ranges plus a custom range, replacing the old 7d/30d/90d preset buttons.
 *
 * Named ranges resolve to concrete from/to dates in the BROWSER'S timezone at
 * the moment of selection (all clock reads happen inside the change handler,
 * never during render). "Today" for a user in Dubai means Dubai's today, even
 * while UTC is still yesterday — which a toISOString()-based date would get
 * wrong for the first four hours of every day.
 *
 * Weeks start on Monday.
 */
export type RangeKey =
  | "this_year" | "last_year"
  | "this_month" | "last_month"
  | "this_week" | "last_week"
  | "today" | "yesterday"
  | "custom";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function rangeFor(key: Exclude<RangeKey, "custom">, now = new Date()): { from: string; to: string } {
  // Normalised to local midnight so day arithmetic can't drift across DST.
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (t.getDay() + 6) % 7; // Monday = 0
  const shift = (base: Date, days: number) => {
    const d = new Date(base);
    d.setDate(base.getDate() + days);
    return d;
  };
  switch (key) {
    case "today":
      return { from: ymd(t), to: ymd(t) };
    case "yesterday": {
      const y = shift(t, -1);
      return { from: ymd(y), to: ymd(y) };
    }
    case "this_week":
      return { from: ymd(shift(t, -dow)), to: ymd(t) };
    case "last_week": {
      const mon = shift(t, -dow - 7);
      return { from: ymd(mon), to: ymd(shift(mon, 6)) };
    }
    case "this_month":
      return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: ymd(t) };
    case "last_month":
      // Day 0 of this month = the last day of the previous month.
      return { from: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: ymd(new Date(t.getFullYear(), t.getMonth(), 0)) };
    case "this_year":
      return { from: `${t.getFullYear()}-01-01`, to: ymd(t) };
    case "last_year":
      return { from: `${t.getFullYear() - 1}-01-01`, to: `${t.getFullYear() - 1}-12-31` };
  }
}

const OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "custom", label: "Custom date range" },
];

export default function DateRangePicker({
  initialKey = "this_month",
  initialFrom,
  initialTo,
  onApply,
}: {
  initialKey?: RangeKey;
  initialFrom?: string;
  initialTo?: string;
  /** Fired with concrete YYYY-MM-DD dates whenever a range takes effect. */
  onApply: (from: string, to: string) => void;
}) {
  const [key, setKey] = useState<RangeKey>(initialKey);
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  function pick(k: RangeKey) {
    setKey(k);
    if (k === "custom") return; // wait for Apply — half-typed dates shouldn't fire queries
    const r = rangeFor(k);
    setFrom(r.from);
    setTo(r.to);
    onApply(r.from, r.to);
  }

  return (
    <>
      <select className="search-box" style={{ width: 165 }} value={key} onChange={(e) => pick(e.target.value as RangeKey)} aria-label="Date range">
        {OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      {key === "custom" && (
        <>
          <input type="date" className="search-box" style={{ width: 140 }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="search-box" style={{ width: 140 }} value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="filter-btn" onClick={() => from && to && from <= to && onApply(from, to)}>Apply</button>
        </>
      )}
    </>
  );
}
