// Apify performance scrapers for the Social Performance benchmark.
//
// One generic actor runner + a defensive normalizer per platform. Each returns
// the account's follower count and its recent posts (with likes / comments /
// shares / plays and a post type), from which the ingest computes the report's
// aggregates. Community actors change their output shape often, so every field
// is read with several fallback key names. A failing platform logs and returns
// null/[]; it never sinks the whole run.
import type { PerfPlatform, PostType } from "@/lib/perfTypes";
import { WINDOW_DAYS, type TimeWindow } from "@/lib/socialTypes";

export interface RawPerfPost {
  external_id: string | null;
  url: string | null;
  type: PostType;
  posted_at: string | null; // ISO
  likes: number;
  comments: number;
  shares: number;
  plays: number | null;
  caption: string | null;
}

export interface PerfScrapeResult {
  followers: number | null;
  posts: RawPerfPost[];
  /**
   * Set when the account resolved but returned nothing usable, so the caller can
   * say WHY it logged "0 posts". Without this, a dead handle and a page that
   * simply hasn't posted this month look identical in the run log.
   */
  note?: string;
}

export interface PerfScrapeCtx {
  window: TimeWindow;
  maxItems: number;
  p: (msg: string) => void;
  timeoutMs?: number;
}

// ── tiny helpers (mirror lib/social.ts) ─────────────────────────
function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function firstStr(o: any, keys: string[]): string | null {
  for (const k of keys) { const v = str(o?.[k]); if (v) return v; }
  return null;
}
function firstNum(o: any, keys: string[]): number {
  for (const k of keys) { if (o?.[k] != null) return num(o[k]); }
  return 0;
}
function firstNumOrNull(o: any, keys: string[]): number | null {
  for (const k of keys) { if (o?.[k] != null) { const n = numOrNull(o[k]); if (n != null) return n; } }
  return null;
}
function withinWindow(iso: string | null, window: TimeWindow): boolean {
  if (!iso) return true; // keep undated rather than silently drop
  return Date.now() - new Date(iso).getTime() <= WINDOW_DAYS[window] * 864e5;
}

/** Run an Apify actor synchronously and return its dataset items. Throws on failure. */
async function runApify(actor: string, input: unknown, timeoutMs = 110_000): Promise<any[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set");
  const secs = Math.max(20, Math.round(timeoutMs / 1000));
  const url =
    `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${secs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`HTTP ${res.status} ${body}`);
    }
    const items = await res.json();
    return Array.isArray(items) ? items : [];
  } catch (e: any) {
    if (e?.name === "AbortError" || /abort/i.test(String(e?.message))) {
      throw new Error(`timed out after ${secs}s (actor too slow — lower Items/platform or disable it)`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── handle normalization ────────────────────────────────────────
/** Strip @ / URL down to a bare username (Instagram, TikTok). */
function toUsername(handle: string): string {
  let h = handle.trim();
  const m = h.match(/(?:instagram|tiktok)\.com\/@?([^/?#]+)/i);
  if (m) h = m[1];
  return h.replace(/^@/, "").replace(/\/+$/, "");
}
/** Ensure a full Facebook page URL. */
function toFacebookUrl(handle: string): string {
  const h = handle.trim();
  if (/^https?:\/\//i.test(h)) return h;
  return `https://www.facebook.com/${h.replace(/^@/, "").replace(/\/+$/, "")}`;
}
/**
 * Reduce a LinkedIn company URL to its bare slug, which is what a company-posts
 * actor identifies a page by.
 *
 * Hyphens are KEPT — the slug is an identifier, not a search phrase. Any
 * regional host (ae./uk./de.linkedin.com) is stripped: LinkedIn serves the same
 * page under every country subdomain, so a URL copied out of a local search
 * result must not carry "ae.linkedin.com" into the actor input.
 */
function toLinkedInCompany(handle: string): string {
  return handle
    .trim()
    .replace(/^https?:\/\/([a-z]{2}\.|www\.)?linkedin\.com\/(company|in|school)\//i, "")
    .replace(/[/?#].*$/, "")
    .trim();
}

/** Window start as YYYY-MM-DD, for actors that can filter server-side. */
function windowStartISO(window: TimeWindow): string {
  return new Date(Date.now() - WINDOW_DAYS[window] * 864e5).toISOString().slice(0, 10);
}

// ── mapping helpers ─────────────────────────────────────────────
function igType(raw: string | null): PostType {
  const t = (raw || "").toLowerCase();
  if (t.includes("video") || t.includes("reel") || t.includes("clip")) return "reel";
  if (t.includes("sidecar") || t.includes("carousel") || t.includes("album")) return "carousel";
  return "image";
}

// ── per-platform scrape + normalize ─────────────────────────────

async function scrapeInstagram(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const username = toUsername(handle);
  // Profile scraper returns a profile object per username with followersCount +
  // a latestPosts[] array. We tolerate actors that instead return posts directly.
  const items = await runApify(
    actor,
    { usernames: [username], resultsLimit: ctx.maxItems, resultsType: "posts" },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const rawPosts: any[] = [];
  for (const it of items) {
    const f = firstNumOrNull(it, ["followersCount", "followers", "ownerFollowersCount"]);
    if (f != null && followers == null) followers = f;
    if (Array.isArray(it.latestPosts)) rawPosts.push(...it.latestPosts);
    else if (Array.isArray(it.posts)) rawPosts.push(...it.posts);
    else if (it.shortCode || it.type || it.likesCount != null || it.caption != null) rawPosts.push(it);
  }
  const posts: RawPerfPost[] = [];
  for (const it of rawPosts.slice(0, ctx.maxItems)) {
    const posted = toISO(it.timestamp ?? it.taken_at_timestamp ?? it.takenAt ?? it.taken_at ?? it.date);
    if (!withinWindow(posted, ctx.window)) continue;
    const code = firstStr(it, ["shortCode", "shortcode", "code"]);
    posts.push({
      external_id: code ?? firstStr(it, ["id", "pk", "url"]),
      url: code ? `https://www.instagram.com/p/${code}/` : firstStr(it, ["url"]),
      type: igType(firstStr(it, ["type", "productType", "mediaType"])),
      posted_at: posted,
      likes: firstNum(it, ["likesCount", "likes", "like_count"]),
      comments: firstNum(it, ["commentsCount", "comments", "comment_count"]),
      shares: 0,
      plays: firstNumOrNull(it, ["videoViewCount", "videoPlayCount", "playCount", "viewsCount", "views", "igPlayCount"]),
      caption: firstStr(it, ["caption", "text"]),
    });
  }
  return { followers, posts };
}

async function scrapeTikTok(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const username = toUsername(handle);
  const items = await runApify(
    actor,
    { profiles: [username], resultsPerPage: ctx.maxItems, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    const author = it.authorMeta ?? it.author ?? {};
    const f = firstNumOrNull(author, ["fans", "followers", "followerCount"]) ?? firstNumOrNull(it, ["fans", "followers"]);
    if (f != null && followers == null) followers = f;
    const posted = toISO(it.createTimeISO ?? it.createTime ?? it.created ?? it.uploadedAt);
    if (!withinWindow(posted, ctx.window)) continue;
    posts.push({
      external_id: firstStr(it, ["id", "videoId", "webVideoUrl"]),
      url: firstStr(it, ["webVideoUrl", "url", "videoUrl"]),
      type: "video", // every TikTok post is a video
      posted_at: posted,
      likes: firstNum(it, ["diggCount", "likes", "likesCount", "hearts"]),
      comments: firstNum(it, ["commentCount", "comments", "commentsCount"]),
      shares: firstNum(it, ["shareCount", "shares"]),
      plays: firstNumOrNull(it, ["playCount", "plays", "views", "viewCount"]),
      caption: firstStr(it, ["text", "caption", "desc"]),
    });
  }
  return { followers, posts };
}

/**
 * Facebook page-level metadata (follower count).
 *
 * The posts scraper returns POSTS — its items carry no page follower figure at
 * all, which is why every Facebook row rendered "? followers". Page stats live
 * in a separate actor, so we pay for a second (small, one-page) run to get them.
 *
 * Returns null on any failure: a missing follower count must never fail the
 * whole account, because the posts are the more valuable half.
 */
const FB_PAGE_ACTOR = process.env.APIFY_FB_PAGE_ACTOR || "apify/facebook-pages-scraper";

async function scrapeFacebookPage(
  pageUrl: string,
  ctx: PerfScrapeCtx,
): Promise<{ followers: number | null; exists: boolean }> {
  try {
    const items = await runApify(
      FB_PAGE_ACTOR,
      { startUrls: [{ url: pageUrl }] },
      Math.min(60_000, ctx.timeoutMs ?? 60_000),
    );
    const page = items.find((it) => it && !it.error) ?? items[0];
    if (!page) return { followers: null, exists: false };
    // Prefer followers; "likes" is the older page-likes metric and runs a little
    // lower, but it beats showing nothing.
    const followers = firstNumOrNull(page, ["followers", "followersCount", "followerCount", "likes", "likesCount"]);
    return { followers, exists: true };
  } catch {
    return { followers: null, exists: false };
  }
}

async function scrapeFacebook(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const pageUrl = toFacebookUrl(handle);
  // Both runs at once — the page scrape is small and shouldn't extend the wall
  // clock of an already-slow posts scrape.
  const [items, page] = await Promise.all([
    runApify(actor, { startUrls: [{ url: pageUrl }], resultsLimit: ctx.maxItems }, ctx.timeoutMs),
    scrapeFacebookPage(pageUrl, ctx),
  ]);
  let followers: number | null = page.followers;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    const f =
      firstNumOrNull(it, ["pageFollowers", "followers", "followersCount", "pageLikes", "likes_count"]) ??
      firstNumOrNull(it.pageInfo ?? {}, ["followers", "likes"]);
    if (f != null && followers == null) followers = f;
    const posted = toISO(it.time ?? it.timestamp ?? it.date ?? it.publishedTime ?? it.createdTime);
    if (!withinWindow(posted, ctx.window)) continue;
    const plays = firstNumOrNull(it, ["videoViewCount", "viewsCount", "videoViews", "views"]);
    posts.push({
      external_id: firstStr(it, ["postId", "id", "url", "postUrl", "facebookUrl"]),
      url: firstStr(it, ["url", "postUrl", "facebookUrl", "topLevelUrl"]),
      type: plays != null && plays > 0 ? "video" : "image",
      posted_at: posted,
      likes: firstNum(it, ["likes", "likesCount", "reactionsCount", "reactions"]),
      comments: firstNum(it, ["comments", "commentsCount"]),
      shares: firstNum(it, ["shares", "sharesCount"]),
      plays,
      caption: firstStr(it, ["text", "message", "postText", "caption"]),
    });
  }
  // Distinguish the three ways Facebook can give us nothing.
  let note: string | undefined;
  if (!posts.length) {
    if (!page.exists && !items.length) note = "page not reachable — check the URL is the public page";
    else if (!items.length) note = "page found but the posts scraper returned nothing (often a login wall)";
    else note = `page found, ${items.length} post(s) fetched but none inside the window`;
  }
  return { followers, posts, note };
}

async function scrapeLinkedIn(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  // `companies`, NOT `searchQueries`. The old input ran a KEYWORD SEARCH across
  // all of LinkedIn, so it returned whatever posts happened to mention the brand
  // — anyone's posts, not the company's. Every brand came back with exactly
  // maxItems posts and no follower count, which is the signature of that bug.
  //
  // A company-posts actor takes the page itself and returns its own posts plus
  // the company profile (which carries the follower count).
  const company = toLinkedInCompany(handle);
  const items = await runApify(
    actor,
    {
      companies: [company],
      maxPosts: ctx.maxItems,
      postedLimitDate: windowStartISO(ctx.window),
      includeReposts: false, // a repost isn't the brand's own content
      includeQuotePosts: true,
    },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    // The actor merges company profile + posts, so the follower count can sit on
    // the item, on a nested company object, or arrive as its own profile-only row.
    const f =
      firstNumOrNull(it, ["followers", "followerCount", "followersCount", "companyFollowers"]) ??
      firstNumOrNull(it.company ?? it.companyProfile ?? it.author ?? {}, ["followers", "followerCount", "followersCount"]);
    if (f != null && followers == null) followers = f;
    const content = firstStr(it, ["content", "text", "postContent", "description"]);
    if (!content) continue;
    const posted = toISO(it.postedAt?.date ?? it.postedAtISO ?? it.date ?? it.time ?? it.publishedAt);
    if (!withinWindow(posted, ctx.window)) continue;
    const plays = firstNumOrNull(it, ["videoViewCount", "views", "impressions"]);
    posts.push({
      external_id: firstStr(it, ["id", "urn", "linkedinUrl", "url"]),
      url: firstStr(it, ["linkedinUrl", "url", "postUrl"]),
      type: plays != null ? "video" : "text",
      posted_at: posted,
      likes: num(it.engagement?.likes) || firstNum(it, ["reactions", "likes", "numLikes", "reactionsCount"]),
      comments: num(it.engagement?.comments) || firstNum(it, ["comments", "numComments", "commentsCount"]),
      shares: num(it.engagement?.shares) || firstNum(it, ["shares", "reposts"]),
      plays,
      caption: content,
    });
  }
  const note = posts.length
    ? undefined
    : `no posts returned for company "${company}" — check the LinkedIn slug in Advanced`;
  return { followers, posts, note };
}

const SCRAPERS: Record<PerfPlatform, (actor: string, handle: string, ctx: PerfScrapeCtx) => Promise<PerfScrapeResult>> = {
  instagram: scrapeInstagram,
  tiktok: scrapeTikTok,
  facebook: scrapeFacebook,
  linkedin: scrapeLinkedIn,
};

export async function scrapePerfAccount(
  platform: PerfPlatform,
  actor: string,
  handle: string,
  ctx: PerfScrapeCtx,
): Promise<PerfScrapeResult> {
  return SCRAPERS[platform](actor, handle, ctx);
}
