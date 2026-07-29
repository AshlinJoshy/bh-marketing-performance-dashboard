import { NextResponse } from "next/server";
import { getPaidData } from "@/lib/paid";

export const dynamic = "force-dynamic";
// Accounts are queried concurrently but each gets up to 25s, so a slow platform
// still needs headroom above the individual query timeout.
export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const days = Number(searchParams.get("days") || 30);
  try {
    const data = await getPaidData(from, to, days);
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[digital] failed", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
