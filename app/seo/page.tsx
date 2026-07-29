import type { Metadata } from "next";
import SeoDashboard from "@/components/SeoDashboard";
import { getSeoData } from "@/lib/seo";

export const metadata: Metadata = {
  title: "SEO & AIO — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
export const maxDuration = 45;

// Initial range = this month (UTC), matching the date picker's default so the
// server-rendered numbers agree with what the control says.
function thisMonth() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`,
    to: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
  };
}

export default async function SeoPage() {
  const { from, to } = thisMonth();
  const initial = await getSeoData(from, to);
  return <SeoDashboard initial={initial} />;
}
