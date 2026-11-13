-- Cadence cloud library: run once in Supabase → SQL Editor.
create table if not exists public.tracks (
  id text primary key,
  data jsonb not null default '{}',
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
create table if not exists public.playlists (
  id text primary key,
  data jsonb not null default '{}',
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.tracks enable row level security;
alter table public.playlists enable row level security;

drop policy if exists "signed in can do everything" on public.tracks;
create policy "signed in can do everything" on public.tracks for all to authenticated using (true) with check (true);
drop policy if exists "signed in can do everything" on public.playlists;
create policy "signed in can do everything" on public.playlists for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public, file_size_limit)
values ('music', 'music', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = 104857600;

drop policy if exists "cadence read" on storage.objects;
drop policy if exists "cadence write" on storage.objects;
drop policy if exists "cadence update" on storage.objects;
drop policy if exists "cadence delete" on storage.objects;
create policy "cadence read" on storage.objects for select to authenticated using (bucket_id = 'music');
create policy "cadence write" on storage.objects for insert to authenticated with check (bucket_id = 'music');
create policy "cadence update" on storage.objects for update to authenticated using (bucket_id = 'music');
create policy "cadence delete" on storage.objects for delete to authenticated using (bucket_id = 'music');
