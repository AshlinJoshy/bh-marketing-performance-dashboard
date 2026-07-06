// Shared, framework-free types for the Social Performance benchmark (People
// Sentiment tab → "Performance" view). No server imports so both the client
// component and the server modules can import from here.
//
// This is the live, in-dashboard version of the competitor Instagram deck:
// betterhomes vs rival agencies on each platform — followers, posting volume &
// format mix, avg likes / comments, reel-plays (reach proxy), engagement rate,
// total reach and top posts. Same concept, every platform, scraped via Apify.
import type { TimeWindow } from "@/lib/socialTypes";

export type PerfPlatform = "instagram" | "tiktok" | "facebook" | "linkedin";

// Post shape after normalizing a platform's output. "reel" and "video" both
// count as video for the format-mix / reach maths; images + carousels don't.
export type PostType = "reel" | "video" | "image" | "carousel" | "text";

export interface PerfPlatformMeta {
  key: PerfPlatform;
  name: string;
  /** Does the platform expose a public play/view count we can use as a reach proxy? */
  hasPlays: boolean;
  /** What we call that reach proxy in the UI. */
  playLabel: string;
  /** What we call a "video" post on this platform. */
  videoLabel: string;
  note: string;
}

export const PERF_PLATFORMS: PerfPlatformMeta[] = [
  { key: "instagram", name: "Instagram", hasPlays: true,  playLabel: "Reel plays",  videoLabel: "Reels",  note: "Followers, posts, reels, likes, comments, reel plays (reach proxy)." },
  { key: "tiktok",    name: "TikTok",    hasPlays: true,  playLabel: "Video plays", videoLabel: "Videos", note: "Followers, video plays, likes, comments, shares — richest public reach data." },
  { key: "facebook",  name: "Facebook",  hasPlays: true,  playLabel: "Video views", videoLabel: "Videos", note: "Page followers, post reactions, comments, shares, video views." },
  { key: "linkedin",  name: "LinkedIn",  hasPlays: false, playLabel: "—",           videoLabel: "Videos", note: "Company followers, posts, reactions, comments. No public reach figure." },
];

export const PERF_PLATFORM_META = Object.fromEntries(PERF_PLATFORMS.map((p) => [p.key, p])) as Record<
  PerfPlatform,
  PerfPlatformMeta
>;

// A benchmarked account: betterhomes (isUs) or a competitor agency. `handles`
// is the platform-specific identifier the scraper needs — an @username for
// Instagram/TikTok, a page/company URL or slug for Facebook/LinkedIn.
export interface PerfBrand {
  name: string;
  isUs: boolean;
  handles: Partial<Record<PerfPlatform, string>>;
}

export interface PerfConfig {
  brands: PerfBrand[];
  /** Apify actor id (owner/name) per platform — editable so it can be fixed without a deploy. */
  actors: Record<PerfPlatform, string>;
  defaults: { window: TimeWindow; maxItems: number };
}

// One scraped post (used for the "top posts" cards + to compute the aggregates).
export interface PerfPost {
  id: string;
  brand: string;
  is_us: boolean;
  platform: PerfPlatform | string;
  external_id: string | null;
  url: string | null;
  type: PostType | string;
  posted_at: string | null;
  likes: number;
  comments: number;
  shares: number;
  plays: number | null;
  caption: string | null;
}

// Per-brand-per-platform snapshot the benchmark UI reads. Computed from the
// scraped posts at run time (a report is a point-in-time snapshot), or seeded.
export interface PerfMetrics {
  brand: string;
  is_us: boolean;
  platform: PerfPlatform | string;
  followers: number | null;
  posts: number;
  reels: number; // video-type posts
  images: number; // non-video posts
  avg_likes: number;
  avg_comments: number;
  avg_plays: number | null; // averaged over video posts only
  total_plays: number;
  engagement_rate: number | null; // percent = (avg_likes + avg_comments) / followers × 100
  time_window: string;
  period_label: string;
  source: string; // 'seed' | 'live'
  captured_at: string | null;
}

export interface PerfRun {
  ran_at: string;
  trigger: string;
  ok: boolean;
  time_window: string | null;
  brands: number;
  platforms: string[] | null;
  posts_found: number;
  metrics_written: number;
  error: string | null;
}

// Instagram handles are the four confirmed in the shared report; other-platform
// handles start blank and are filled in the Advanced editor (a blank handle just
// means that account is skipped for that platform until it's set).
export const DEFAULT_PERF_CONFIG: PerfConfig = {
  brands: [
    { name: "betterhomes",        isUs: true,  handles: { instagram: "betterhomesuae",   facebook: "https://www.facebook.com/betterhomesuae" } },
    { name: "Allsopp & Allsopp",  isUs: false, handles: { instagram: "allsoppandallsopp" } },
    { name: "haus & haus",        isUs: false, handles: { instagram: "hausandhaus" } },
    { name: "White & Co",         isUs: false, handles: { instagram: "whiteandcodxb" } },
  ],
  actors: {
    instagram: "apify/instagram-profile-scraper",
    tiktok: "clockworks/tiktok-scraper",
    facebook: "apify/facebook-posts-scraper",
    linkedin: "harvestapi/linkedin-post-search",
  },
  defaults: { window: "month", maxItems: 24 },
};

/** Merge a stored (possibly partial) perf config over the defaults so new fields always exist. */
export function mergePerfConfig(stored: Partial<PerfConfig> | null | undefined): PerfConfig {
  if (!stored) return DEFAULT_PERF_CONFIG;
  const d = DEFAULT_PERF_CONFIG;
  return {
    brands: stored.brands?.length ? stored.brands : d.brands,
    actors: { ...d.actors, ...(stored.actors ?? {}) },
    defaults: { ...d.defaults, ...(stored.defaults ?? {}) },
  };
}

export const isVideoType = (t: string): boolean => t === "reel" || t === "video";
