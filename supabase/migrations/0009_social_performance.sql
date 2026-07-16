-- ════════════════════════════════════════════════════════════════
-- Social Performance benchmark (People Sentiment tab → "Performance").
-- The live, in-dashboard version of the competitor social deck: betterhomes vs
-- rival agencies on each platform (Instagram · TikTok · Facebook · LinkedIn),
-- scraped via Apify. We store a per-brand-per-platform SNAPSHOT of aggregates
-- (a report is point-in-time) plus the individual top posts behind them.
--
-- Kept separate from social_mentions (that table is about SENTIMENT; this one is
-- about REACH & ENGAGEMENT performance).
-- ════════════════════════════════════════════════════════════════

-- Per-brand-per-platform aggregates the benchmark UI reads directly.
create table if not exists social_perf_metrics (
  brand            text not null,
  is_us            boolean not null default false,   -- true = betterhomes (the account we champion)
  platform         text not null,                    -- instagram|tiktok|facebook|linkedin
  followers        integer,
  posts            integer not null default 0,       -- posts in the window
  reels            integer not null default 0,       -- video-type posts (reels/videos)
  images           integer not null default 0,       -- non-video posts (image/carousel/text)
  avg_likes        numeric not null default 0,
  avg_comments     numeric not null default 0,
  avg_plays        numeric,                           -- avg over video posts only (reach proxy); null where n/a
  total_plays      bigint  not null default 0,
  engagement_rate  numeric,                           -- percent: (avg_likes + avg_comments) / followers × 100
  time_window      text,                              -- month|quarter|year ("window" is a reserved SQL word)
  period_label     text,
  source           text not null default 'live',      -- 'seed' | 'live'
  run_id           bigint,
  captured_at      timestamptz not null default now(),
  primary key (brand, platform)
);
create index if not exists social_perf_metrics_platform_idx on social_perf_metrics (platform);

-- Individual posts (top-post cards + the raw behind the aggregates).
create table if not exists social_perf_posts (
  id           text primary key,                     -- stable hash: brand + platform + external id/url
  brand        text not null,
  is_us        boolean not null default false,
  platform     text not null,
  external_id  text,
  url          text,
  type         text not null default 'image',        -- reel|video|image|carousel|text
  posted_at    timestamptz,
  likes        integer not null default 0,
  comments     integer not null default 0,
  shares       integer not null default 0,
  plays        bigint,                                -- reel plays / video views; null for non-video or platforms without it
  caption      text,
  source_actor text,
  run_id       bigint,
  raw          jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists social_perf_posts_platform_idx on social_perf_posts (platform, plays desc nulls last);
create index if not exists social_perf_posts_brand_idx     on social_perf_posts (brand, platform);

-- Run log so the tab can show when the benchmark last refreshed.
create table if not exists social_perf_runs (
  id               bigint generated always as identity primary key,
  ran_at           timestamptz not null default now(),
  trigger          text not null default 'manual',
  ok               boolean not null default true,
  time_window      text,
  brands           integer not null default 0,
  platforms        text[],
  posts_found      integer not null default 0,
  metrics_written  integer not null default 0,
  error            text,
  params           jsonb
);
create index if not exists social_perf_runs_ran_at_idx on social_perf_runs (ran_at desc);

-- RLS: public read (dashboard is read-only + unauthenticated); writes via service role only.
alter table social_perf_metrics enable row level security;
alter table social_perf_posts   enable row level security;
alter table social_perf_runs    enable row level security;

do $$ begin
  create policy "public read social_perf_metrics" on social_perf_metrics for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "public read social_perf_posts" on social_perf_posts for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "public read social_perf_runs" on social_perf_runs for select using (true);
exception when duplicate_object then null; end $$;

-- ── Seed: the Instagram benchmark from the shared report (week of 23–30 Jun 2026)
-- so the tab shows real numbers before the first live run. A live run upserts on
-- (brand, platform) and replaces these; ON CONFLICT DO NOTHING keeps re-running
-- the migration from clobbering fresher live data.
insert into social_perf_metrics
  (brand, is_us, platform, followers, posts, reels, images, avg_likes, avg_comments, avg_plays, total_plays, engagement_rate, time_window, period_label, source)
values
  ('betterhomes',       true,  'instagram', 38109, 7, 2, 5,  72,  7.9,  3394,  6788, 0.21, 'month', 'Week of 23–30 Jun 2026', 'seed'),
  ('Allsopp & Allsopp', false, 'instagram', 44998, 6, 5, 1,  66,  5.7,  5187, 25935, 0.16, 'month', 'Week of 23–30 Jun 2026', 'seed'),
  ('haus & haus',       false, 'instagram', 67562, 2, 1, 1, 255, 30.5, 16547, 16547, 0.42, 'month', 'Week of 23–30 Jun 2026', 'seed'),
  ('White & Co',        false, 'instagram', 27775, 6, 5, 1, 532, 24.0, 12349, 61745, 2.05, 'month', 'Week of 23–30 Jun 2026', 'seed')
on conflict (brand, platform) do nothing;

insert into social_perf_posts
  (id, brand, is_us, platform, type, posted_at, likes, comments, plays, caption, source_actor)
values
  ('seed-ig-white-1',   'White & Co',        false, 'instagram', 'reel', '2026-06-25', 532, 38, 34136, 'Widest-reaching post of the week — 7,186 views · 532 likes · 38 comments.', 'seed'),
  ('seed-ig-haus-1',    'haus & haus',       false, 'instagram', 'reel', '2026-06-26', 274, 50, 16547, 'Highest engagement of any post tracked — 274 likes · 50 comments.',        'seed'),
  ('seed-ig-allsopp-1', 'Allsopp & Allsopp', false, 'instagram', 'reel', '2026-06-24', 221, 21, 11472, 'Standout of five reels — 221 likes · 21 comments.',                          'seed'),
  ('seed-ig-bh-1',      'betterhomes',       true,  'instagram', 'reel', '2026-06-26',  60,  6,  4029, 'betterhomes'' best-reaching post (experiencebh_) — below every competitor''s top reel.', 'seed')
on conflict (id) do nothing;
