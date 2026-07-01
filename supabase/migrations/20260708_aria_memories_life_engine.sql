-- Aria's episodic memory + life engine.
-- aria_memories: distilled moments ('episode'), her daily life ('aria_day'),
-- and follow-up threads ('open_loop'). Embeddings are 384-dim vectors from the
-- Supabase edge runtime's built-in gte-small model (free, no external API).
-- RLS on with no policies: service-role edge functions only.
create table if not exists public.aria_memories (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  kind text not null default 'episode', -- 'episode' | 'aria_day' | 'open_loop'
  content text not null,
  embedding vector(384),
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists aria_memories_client_idx on public.aria_memories (client_id, created_at desc);
create index if not exists aria_memories_kind_idx on public.aria_memories (client_id, kind, created_at desc);
alter table public.aria_memories enable row level security;

-- similarity recall used by companion-chat at every turn
create or replace function public.match_aria_memories(p_client_id text, p_query vector(384), p_count int default 6)
returns table(id uuid, kind text, content text, created_at timestamptz, similarity double precision)
language sql stable
set search_path = public, pg_temp
as $$
  select m.id, m.kind, m.content, m.created_at, 1 - (m.embedding <=> p_query) as similarity
  from public.aria_memories m
  where m.client_id = p_client_id and m.embedding is not null
  order by m.embedding <=> p_query
  limit greatest(1, least(p_count, 20));
$$;
revoke execute on function public.match_aria_memories(text, vector, int) from public, anon, authenticated;

-- her day gets written every morning (6am Phoenix = 13:00 UTC) by companion-day.
-- The live cron job inlines the anon key (already public in the client); this file
-- documents the schedule — see cron.job for the deployed version.
-- select cron.schedule('companion-day-daily','0 13 * * *', $$ select net.http_post(
--   url := 'https://mymunodjaxymhbnhjwjx.supabase.co/functions/v1/companion-day', ...) $$);
