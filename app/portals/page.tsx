import type { Metadata } from "next";
import PortalsDashboard from "@/components/PortalsDashboard";
import { getPortalsData } from "@/lib/portals";

export const metadata: Metadata = {
  title: "Portals — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function PortalsPage() {
  // Default to the year to date, matching the picker's initial selection.
  const initial = await getPortalsData();
  return (
    <>
      <div className="page-title">Portals</div>
      <div className="page-sub">
        Property Finder, Bayut and Dubizzle — leads, deals and commission from the CRM, with cost per lead
        and cost per deal against an assumed spend.
      </div>
      <PortalsDashboard initial={initial} />
    </>
  );
}
