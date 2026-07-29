import type { Metadata } from "next";
import DigitalDashboard from "@/components/DigitalDashboard";
import { getPaidData } from "@/lib/paid";
import { getPaidConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: "Digital Performance — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// One Supermetrics query per selected account, run concurrently, each capped at
// 25s. 60s leaves room for a slow platform without the page itself timing out.
export const maxDuration = 60;

export default async function DigitalPage() {
  const [initial, config] = await Promise.all([getPaidData(), getPaidConfig()]);
  return <DigitalDashboard initial={initial} config={config} />;
}
