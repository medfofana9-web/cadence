-- Cadence cloud library. Run once in Supabase → SQL Editor.
-- Every row and every file belongs to one signed-in person; nobody can read anyone else's library.

-- an earlier draft made shared tables without an owner column; replace those (they held no data yet)
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'tracks')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tracks' and column_name = 'user_id') then
    drop table public.tracks; drop table if exists public.playlists;
  end if;
end $$;

create table if not exists public.tracks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null default '{}',
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists public.playlists (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null default '{}',
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists public.user_state (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.tracks enable row level security;
alter table public.playlists enable row level security;
alter table public.user_state enable row level security;

drop policy if exists "own tracks" on public.tracks;
create policy "own tracks" on public.tracks for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own playlists" on public.playlists;
create policy "own playlists" on public.playlists for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own state" on public.user_state;
create policy "own state" on public.user_state for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit)
values ('music', 'music', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- files live under <user id>/audio/... and <user id>/art/...
drop policy if exists "cadence read" on storage.objects;
drop policy if exists "cadence write" on storage.objects;
drop policy if exists "cadence update" on storage.objects;
drop policy if exists "cadence delete" on storage.objects;
drop policy if exists "own files read" on storage.objects;
drop policy if exists "own files add" on storage.objects;
drop policy if exists "own files change" on storage.objects;
drop policy if exists "own files remove" on storage.objects;
create policy "own files read" on storage.objects for select to authenticated using (bucket_id = 'music' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files add" on storage.objects for insert to authenticated with check (bucket_id = 'music' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files change" on storage.objects for update to authenticated using (bucket_id = 'music' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files remove" on storage.objects for delete to authenticated using (bucket_id = 'music' and (storage.foldername(name))[1] = auth.uid()::text);
