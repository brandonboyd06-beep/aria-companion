-- 2026-09-08: voice notes from Aria + follow-through on open loops
-- Applied to production via the Management API on 2026-09-08 (documented here).
insert into storage.buckets (id, name, public, file_size_limit)
  values ('aria-voice', 'aria-voice', true, 10485760)
  on conflict (id) do update set public = true;
alter table public.aria_media drop constraint if exists aria_media_kind_check;
alter table public.aria_media add constraint aria_media_kind_check check (kind in ('photo','video','voice'));
-- open loops now carry meta.due_at (UTC ms) + meta.asked; companion-life follows up when due_at passes.
