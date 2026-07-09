-- ════════════════════════════════════════════════════════════════
-- SEO tab config: the editable list of target keywords whose Google
-- Search Console average position the dashboard tracks. Single-row JSON
-- (id = 1), same pattern as social_config. Seeded with the 14 keywords
-- from the June 2026 SEO snapshot.
-- ════════════════════════════════════════════════════════════════
create table if not exists seo_config (
  id         integer primary key default 1,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint seo_config_singleton check (id = 1)
);

alter table seo_config enable row level security;
do $$ begin
  create policy "public read seo_config" on seo_config for select using (true);
exception when duplicate_object then null; end $$;

insert into seo_config (id, payload) values (1, '{
  "keywords": [
    "rent apartment abu dhabi",
    "dubai villa for sale",
    "apartment for rent abu dhabi",
    "villa for sale in dubai",
    "apartments for sale in abu dhabi",
    "townhouses for sale in dubai",
    "villas for sale in dubai",
    "dubai marina apartments for sale",
    "villas for sale in sharjah",
    "apartment for sale in dubai",
    "apartment for rent in dubai",
    "property for sale in dubai",
    "villas for sale in abu dhabi",
    "dubai apartment for sale"
  ]
}'::jsonb)
on conflict (id) do nothing;
