-- Aria's media library: every photo and video she has sent, per account.
-- Service-role only (RLS on, no policies); written by companion-image / companion-video,
-- read and pruned through companion-media.
create table if not exists public.aria_media (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  kind        text not null check (kind in ('photo','video')),
  url         text not null,
  prompt      text,
  alt         text,
  source      text,            -- 'chat' | 'selfie' | 'video' | 'extend' | 'backfill' | ...
  model       text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists aria_media_client_created_idx on public.aria_media (client_id, created_at desc);
create unique index if not exists aria_media_client_url_idx on public.aria_media (client_id, url);
alter table public.aria_media enable row level security;
