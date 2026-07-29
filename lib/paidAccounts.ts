// The ad accounts available to pick from on the Digital Performance tab.
//
// This is a snapshot taken from Supermetrics' account discovery, not a live
// call: the Data Fetching API key used elsewhere in this app queries *data*, and
// the account-listing endpoint is a different surface that this deployment has
// not been verified against. Embedding the discovered list keeps the picker
// working without guessing at an API shape.
//
// To refresh it, list the accounts per source in Supermetrics (or via its MCP
// `accounts_discovery`) and update the arrays below. `id` is what gets sent as
// ds_accounts, so it must match exactly — Meta ids carry the `act_` prefix.
//
// Two flags exist because most of the Meta list is not advertising:
//   • disabled — sits in Supermetrics' "CLOSED AND DISABLED ACCOUNTS" group
//   • readOnly — a messaging/CRM integration (WhatsApp, Intercom, Brevo, Kendal),
//                which has no campaigns at all
// Both are hidden in the picker by default, and neither is selected.
import type { PaidPlatform } from "@/lib/paid";

export interface CatalogAccount {
  id: string;
  name: string;
  disabled?: boolean;
  readOnly?: boolean;
}

export const ACCOUNT_CATALOG: Record<PaidPlatform, CatalogAccount[]> = {
  google: [
    { id: "5063000241", name: "Betterhomes" },
    { id: "9449621598", name: "Better Homes - Marketing" },
    { id: "1174729952", name: "Better Homes Exclusive Real Estate LLC" },
    { id: "1222767552", name: "Octopus" },
    { id: "7372975823", name: "PMGT" },
  ],
  meta: [
    { id: "act_418631585177618", name: "betterhomes offplan 1" },
    { id: "act_10091300310884299", name: "betterhomes offplan 2" },
    { id: "act_873275145025438", name: "betterhomes marketing" },
    { id: "act_9508663712551146", name: "Betterhomes Secondary" },
    { id: "act_1133329898077693", name: "Better Homes Exclusive Real Estate L.L.C." },
    { id: "act_687096787494987", name: "Better Homes Exclusive Real Estate L.L.C" },
    { id: "act_411960237528178", name: "Betterhomes Abu Dhabi" },
    { id: "act_824097055597729", name: "Better Homes Abu Dhabi" },
    { id: "act_782531417549125", name: "Betterhomes Sharjah" },
    { id: "act_2943433119142540", name: "PRIME By Betterhomes" },
    { id: "act_1097354057528775", name: "Prime" },
    { id: "act_993826532939364", name: "PMGT" },
    { id: "act_495752121197216", name: "CRC" },
    { id: "act_687203440459757", name: "Recruitment" },
    { id: "act_981545024234000", name: "General" },
    { id: "act_2319302161825058", name: "Jamal Living" },
    { id: "act_1034425181475189", name: "Linda's Real Estate Ads" },
    { id: "act_4253331538279962", name: "Vayla" },
    { id: "act_884786230783156", name: "Al Ansari Nova Tower" },
    { id: "act_2029551921300421", name: "W Residences" },
    { id: "act_3692790661015785", name: "Panchshil realty" },
    { id: "act_2045042082975299", name: "Ashlin Cheeran" },
    { id: "act_2295636433918918", name: "2295636433918918" },
    // Closed / disabled
    { id: "act_519973855921395", name: "Octopus", disabled: true },
    { id: "act_518474986026740", name: "Octopus", disabled: true },
    { id: "act_139082151699470", name: "Octopus", disabled: true },
    { id: "act_4247037508717555", name: "Octopus", disabled: true },
    { id: "act_540064130784532", name: "Waterdrop", disabled: true },
    { id: "act_773087990359196", name: "lindas", disabled: true },
    { id: "act_579014393851950", name: "Ascot", disabled: true },
    { id: "act_4045487835709792", name: "Exclusive - Opula", disabled: true },
    { id: "act_878514231757962", name: "Test WhatsApp Business Account", disabled: true, readOnly: true },
    // Messaging / CRM integrations — no campaigns
    { id: "act_2951145858408793", name: "Octopus Home Maintenance", readOnly: true },
    { id: "act_1424003646030631", name: "bh 971 50 963 1366 x Active Campaign", readOnly: true },
    { id: "act_909043578728235", name: "+971504351297", readOnly: true },
    { id: "act_1086786593586882", name: "bh 971 50 435 1291 x Active Campaign", readOnly: true },
    { id: "act_1406880104245193", name: "bh +971 50 963 7233 x Kendal AI", readOnly: true },
    { id: "act_866633959513030", name: "Betterhomes X Intercom", readOnly: true },
    { id: "act_1286290246885825", name: "bh 15557757950 x brevo", readOnly: true },
    { id: "act_2046658032569424", name: "Betterhomes X Engage", readOnly: true },
    { id: "act_1099727522260802", name: "betterhomes X Kendal", readOnly: true },
  ],
  linkedin: [
    { id: "504276125", name: "Better Homes LLC_1" },
    { id: "511456978", name: "XCC" },
  ],
};

/**
 * Accounts confirmed readable by actually querying them. Supermetrics licenses
 * only a subset of ad accounts for querying, and an account being listed above
 * says nothing about whether it is licensed — so this records what was actually
 * verified, and when.
 *
 * Last re-verified 2026-07-29, after the prioritised list was edited on the
 * hub: betterhomes marketing and Betterhomes Secondary now return live campaign
 * rows (BH-Future-Living-Survey…, BH-Leasing-C1-Tower…, OUTCOME_LEADS, AED).
 */
export const VERIFIED_READABLE: Record<PaidPlatform, string[]> = {
  google: ["5063000241"],
  meta: ["act_418631585177618", "act_873275145025438", "act_9508663712551146"],
  linkedin: ["504276125"],
};

/**
 * Where prioritised accounts are managed. The subscription id comes verbatim
 * from Supermetrics' own rejection message ("To manage your prioritised
 * accounts, follow the link below"), so this is the exact page rather than a
 * guessed one. Append `#datasource-<dsId>` to jump to a platform's section.
 */
export const SUPERMETRICS_SUBSCRIPTION_URL = "https://hub.supermetrics.com/subscriptions/1808889";

/**
 * Accounts confirmed NOT readable — each individually probed through the
 * Supermetrics hub API and rejected as "not a prioritised account". The live
 * dashboard sees these as a bare QUERY_ERROR; this list is what lets that
 * generic code be reported as its verified meaning.
 *
 * Re-probed 2026-07-29 after the prioritised list was edited: marketing and
 * Secondary moved to VERIFIED_READABLE above; offplan 2 was rejected again.
 */
export const VERIFIED_BLOCKED: Record<PaidPlatform, string[]> = {
  google: [],
  meta: ["act_10091300310884299"],
  linkedin: [],
};
