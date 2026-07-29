import type { Metadata } from "next";
import DigitalDashboard from "@/components/DigitalDashboard";
import { getPaidConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: "Digital Performance — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

// Deliberately NO server-side media fetch. One Supermetrics query per selected
// account, each with a 25s ceiling, means the old `await getPaidData()` here
// held the ENTIRE navigation hostage for up to a minute — the sidebar click
// appeared to do nothing. Only the config (one fast Supabase read) is fetched
// on the server; the dashboard shell renders immediately and the client loads
// media and CRM with in-place skeletons, the same way the SEO tab handles its
// slow half.
export default async function DigitalPage() {
  const config = await getPaidConfig();
  return <DigitalDashboard initial={null} config={config} />;
}
