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

async function scrapeFacebook(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const pageUrl = toFacebookUrl(handle);
  const items = await runApify(actor, { startUrls: [{ url: pageUrl }], resultsLimit: ctx.maxItems }, ctx.timeoutMs);
  let followers: number | null = null;
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
  return { followers, posts };
}

async function scrapeLinkedIn(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  // Best-effort: public LinkedIn exposes no play counts and follower counts are
  // unreliable via search. We pull the company's recent posts by name and read
  // reactions/comments; plays stay null.
  const query = handle.replace(/^https?:\/\/(www\.)?linkedin\.com\/(company|in)\//i, "").replace(/\/+$/, "");
  const items = await runApify(
    actor,
    { searchQueries: [query], maxPosts: ctx.maxItems, sortBy: "date", profileScraperMode: "short" },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    const f = firstNumOrNull(it, ["followers", "followerCount", "companyFollowers"]);
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
  return { followers, posts };
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
