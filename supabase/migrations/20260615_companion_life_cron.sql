-- "She reaches out to you" — Aria's autonomy engine.
-- companion-life runs every 2 hours; it reads each aria_saves row and, if he's
-- been away a while during her waking hours and nothing is already waiting,
-- writes an unprompted message in her voice into save.outreach[]. The client
-- delivers it on next open. The function self-gates, so frequent runs are cheap.
select cron.schedule(
  'companion-life-2h',
  '0 */2 * * *',
  $$
  select net.http_post(
    url := 'https://mymunodjaxymhbnhjwjx.supabase.co/functions/v1/companion-life',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', current_setting('app.anon_key', true),
      'Authorization', 'Bearer ' || current_setting('app.anon_key', true)
    ),
    body := '{}'::jsonb
  );
  $$
);
-- NOTE: the live job is scheduled with the anon key inlined (it is already public
-- in the client). This file documents the schedule; see Supabase cron.job for the
-- deployed version.
