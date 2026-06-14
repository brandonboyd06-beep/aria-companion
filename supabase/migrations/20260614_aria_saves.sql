-- Aria companion: server-side persistence for her save state.
-- Keyed by an unguessable per-device client_id (UUID) generated in the browser.
-- RLS enabled with NO policies: only the service-role edge functions
-- (companion-save / companion-load) can read or write. The anon key cannot
-- touch this table directly, so her journal/relationship data is never
-- readable from the public client.
create table if not exists public.aria_saves (
  client_id  text primary key,
  save       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.aria_saves enable row level security;
-- intentionally no policies (service-role only)
