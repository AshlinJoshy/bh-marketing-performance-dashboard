import type { Metadata } from "next";
import SettingsPanel from "@/components/SettingsPanel";
import { getSettingsInfo } from "@/lib/settingsInfo";
import { getAppSettings } from "@/lib/appSettings";

export const metadata: Metadata = { title: "Settings — betterhomes Marketing Hub" };

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [info, settings] = await Promise.all([getSettingsInfo(), getAppSettings()]);
  return (
    <>
      <div className="page-title">Settings</div>
      <div className="page-sub">Admin. Changes here apply to everyone who uses the dashboard.</div>
      <SettingsPanel info={info} settings={settings} />
    </>
  );
}
