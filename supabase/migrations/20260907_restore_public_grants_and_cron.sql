-- 2026-09-07: repair after a sibling project on this shared Supabase instance locked the
-- database down on 2026-08-02 (~15:00 UTC) and silently broke every app that uses `public`.
--
-- What was found in production:
--   * role `authenticator` carried `pgrst.db_schemas = travel_planner`, which overrides the
--     platform "exposed schemas" setting, so PostgREST served ONLY travel_planner
--     ("Invalid schema: public" for every supabase-js call, including service-role calls
--     from edge functions: companion-load/-save/-life/-day/-reflect/-image config reads).
--   * USAGE on schema public and ALL table/sequence/function grants had been revoked from
--     anon, authenticated and service_role (only postgres kept grants).
--   * every pg_cron job had been unscheduled (jobs 25 focus.tick, 26 companion-life-2h,
--     28 consolidate-memory, 29 memory salience update, 30 companion-day-daily).
--   * storage buckets aria-photos / aria-videos had lost `public = true` (fixed earlier the
--     same day; see the commit "photos back (bucket public again)").
--
-- Applied via the Management API (this file documents it; it is idempotent to re-run):

alter role authenticator reset pgrst.db_schemas;
-- platform setting (Dashboard → API → Exposed schemas) set to:
--   public, graphql_public, dog_training, travel_planner

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
select pg_notify('pgrst', 'reload schema');
-- (every public table has RLS enabled, so restoring the default grants exposes nothing new)

-- Aria's two schedules, re-created exactly as they ran before (the anon key is inlined in
-- the live jobs, as it was originally; it is the public client key):
--   companion-life-2h    '0 */2 * * *'  → POST /functions/v1/companion-life  body {}
--   companion-day-daily  '0 13 * * *'   → POST /functions/v1/companion-day   body {}
-- The other three jobs (focus.tick, consolidate-memory, salience update) belong to other
-- apps on this project and were NOT re-created here; their commands are recoverable from
-- cron.job_run_details (jobid 25, 28, 29).
