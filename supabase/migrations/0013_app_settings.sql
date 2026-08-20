-- ════════════════════════════════════════════════════════════════
-- Global admin switches, set once and obeyed by everyone.
--
-- Exists for one specific problem: Supermetrics bills a monthly ROW quota,
-- and a handful of Digital tab loads can spend a large share of it (one
-- query per selected ad account, 10,000 rows each). When the quota is gone,
-- every Supermetrics-backed figure fails until the month rolls over.
--
-- So an admin needs to be able to stop those calls for the WHOLE
-- deployment, not just their own browser. A client-side toggle would not
-- do: every tab is a force-dynamic server component that fetches during
-- render, so the decision has to be readable on the server before any HTTP
-- call is made. Hence a row in the database rather than a cookie or a
-- localStorage flag.
--
-- Singleton JSON row (id = 1), same pattern as seo_config / paid_config.
-- Readable by anyone (the dashboard has to know whether to show the
-- "Supermetrics is off" notice); writes go through the service role behind
-- the settings PIN.
-- ════════════════════════════════════════════════════════════════
create table if not exists app_settings (
  id         integer primary key default 1,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);

alter table app_settings enable row level security;
do $$ begin
  create policy "public read app_settings" on app_settings for select using (true);
exception when duplicate_object then null; end $$;

-- supermetricsEnabled defaults TRUE so an empty table behaves exactly as the
-- app did before this switch existed. `note` is shown to viewers when off, so
-- the reason is on screen rather than in someone's head.
insert into app_settings (id, payload) values (1, '{
  "supermetricsEnabled": true,
  "note": ""
}'::jsonb)
on conflict (id) do nothing;
