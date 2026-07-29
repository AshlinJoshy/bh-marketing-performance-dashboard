-- ════════════════════════════════════════════════════════════════
-- Digital Performance tab config: which ad accounts to showcase.
--
-- Needed because the connected platforms expose far more accounts than
-- are actually advertised on — 41 Meta ad accounts (many in a "CLOSED AND
-- DISABLED ACCOUNTS" group, several read-only WhatsApp/Intercom
-- integrations), 5 Google Ads, 2 LinkedIn. Showing all of them would bury
-- the live campaigns.
--
-- Separately, Supermetrics only licenses a subset of ad accounts for
-- querying ("prioritised accounts"), so an account can be selectable here
-- and still not be readable. lib/paid.ts reports those per account rather
-- than failing the tab.
--
-- Singleton JSON row (id = 1), same pattern as seo_config / social_config.
-- Seeded empty: the tab prompts for a selection rather than guessing which
-- accounts matter.
-- ════════════════════════════════════════════════════════════════
create table if not exists paid_config (
  id         integer primary key default 1,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint paid_config_singleton check (id = 1)
);

alter table paid_config enable row level security;
do $$ begin
  create policy "public read paid_config" on paid_config for select using (true);
exception when duplicate_object then null; end $$;

-- accounts: { google: [{id,name}], meta: [...], linkedin: [...] }
insert into paid_config (id, payload) values (1, '{
  "accounts": { "google": [], "meta": [], "linkedin": [] }
}'::jsonb)
on conflict (id) do nothing;
