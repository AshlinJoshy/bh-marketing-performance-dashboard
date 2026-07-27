-- Pin the search_path on set_updated_at().
--
-- The function was created without one, so it resolved unqualified names using
-- whatever search_path the caller had. A role able to create objects in an
-- earlier schema on that path could shadow a built-in and have it run inside
-- the trigger. Supabase's database linter flags this as
-- `function_search_path_mutable`.
--
-- The body only touches NEW and now(), so an empty search_path is safe as long
-- as now() is schema-qualified.
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = pg_catalog.now(); return new; end;
$$ language plpgsql
set search_path = '';
