-- Lumos Strike – Supabase schema (run in the SQL editor). Enable "Anonymous sign-ins" under Auth > Providers.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default 'Operator',
  level int not null default 1,
  data jsonb not null default '{}'::jsonb,
  last_seen timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists public.matches (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz default now()
);
create table if not exists public.friends (
  user_id uuid references auth.users(id) on delete cascade,
  friend_id uuid references public.profiles(id) on delete cascade,
  primary key (user_id, friend_id)
);
create table if not exists public.party_invites (
  id bigint generated always as identity primary key,
  from_id uuid references auth.users(id) on delete cascade,
  to_id uuid references auth.users(id) on delete cascade,
  game text not null default 'lumos-strike',
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.friends enable row level security;
alter table public.party_invites enable row level security;

create policy "profiles readable" on public.profiles for select using (true);
create policy "own profile write" on public.profiles for insert with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);
create policy "own matches" on public.matches for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own friends" on public.friends for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "invites visible to both" on public.party_invites for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "send invites" on public.party_invites for insert with check (auth.uid() = from_id);
