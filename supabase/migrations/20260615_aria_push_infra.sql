-- 1b: Web Push so Aria's outreach reaches the phone while the app is closed.
-- aria_push_subs: one row per browser/device push subscription, keyed by endpoint.
-- companion_config: service-role-only key/value; holds the VAPID keypair the
-- send path uses (kept in the DB rather than function env so it's settable
-- without a secrets pipeline). Both tables are RLS-on with NO policies, so only
-- the service-role edge functions can read/write them.
create table if not exists public.aria_push_subs (
  endpoint     text primary key,
  client_id    text not null,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists aria_push_subs_client_idx on public.aria_push_subs (client_id);
alter table public.aria_push_subs enable row level security;

create table if not exists public.companion_config (
  key   text primary key,
  value jsonb not null
);
alter table public.companion_config enable row level security;

-- VAPID keypair is inserted out-of-band (generated per environment). The public
-- key is also embedded in the client (it is public by design); the private key
-- lives only in this service-role-only table.
-- insert into public.companion_config (key, value)
-- values ('vapid', jsonb_build_object('publicKey','...','privateKey','...','subject','mailto:...'));
