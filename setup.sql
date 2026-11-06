-- =====================================================================
-- Ambulance Planner – Route deployment database (Supabase / Postgres)
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- Safe to run again: it only creates what is missing and refreshes
-- the functions and access rules.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Staff master: pilots (drivers) and EMTs ----------
create table if not exists public.staff (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  role       text not null default 'Pilot' check (role in ('Pilot', 'EMT')),
  phone      text,
  emp_code   text unique,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Ambulance master (shared with the radius planner) ----------
create table if not exists public.ambulances (
  id            uuid primary key default gen_random_uuid(),
  reg_no        text not null unique check (length(trim(reg_no)) > 0),
  type          text not null default 'BLS' check (type in ('BLS', 'ALS', 'PTV', 'FRV')),
  base_name     text,
  base_lat      double precision check (base_lat between -90 and 90),
  base_lng      double precision check (base_lng between -180 and 180),
  default_pilot uuid references public.staff(id) on delete set null,
  default_emt   uuid references public.staff(id) on delete set null,
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- Routes: ordered stops, timings, cached road legs ----------
create table if not exists public.routes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Deployments: one ambulance, one route, one day ----------
create table if not exists public.deployments (
  id           uuid primary key default gen_random_uuid(),
  dep_date     date not null,
  ambulance_id uuid not null references public.ambulances(id) on delete restrict,
  pilot_id     uuid references public.staff(id) on delete set null,
  emt_id       uuid references public.staff(id) on delete set null,
  route_id     uuid references public.routes(id) on delete set null,
  start_time   text not null default '08:00' check (start_time ~ '^\d{2}:\d{2}$'),
  end_time     text not null default '16:00' check (end_time ~ '^\d{2}:\d{2}$'),
  status       text not null default 'Planned' check (status in ('Planned', 'Assigned', 'In progress', 'Completed', 'Cancelled')),
  notes        text,
  token        text not null unique default encode(gen_random_bytes(16), 'hex'),
  plan         jsonb not null default '{}'::jsonb,   -- frozen schedule the team sees
  progress     jsonb not null default '{}'::jsonb,   -- actual arrival / halt / departure times
  last_lat     double precision,
  last_lng     double precision,
  last_acc     double precision,
  last_seen    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists deployments_date_idx on public.deployments(dep_date);
alter table public.ambulances add column if not exists default_route uuid references public.routes(id) on delete set null;

-- ---------- Location trail sent by the team phone (with consent) ----------
create table if not exists public.pings (
  id            bigserial primary key,
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  lat           double precision not null,
  lng           double precision not null,
  acc           double precision,
  at            timestamptz not null default now()
);
create index if not exists pings_dep_idx on public.pings(deployment_id, at);

-- ---------- Optional population grid (lat, lng, people) ----------
create table if not exists public.pop_grid (
  id  bigserial primary key,
  lat double precision not null,
  lng double precision not null,
  pop double precision not null check (pop >= 0)
);

-- ---------- Shared settings (defaults) ----------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- Who may use the admin pages ----------
-- The first person to sign in becomes an admin automatically; after that
-- only emails on this list can see or change data (add more in the app:
-- Route deployment → Settings → Admins).
create table if not exists public.app_admins (
  email    text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (auth.jwt() ->> 'email') is not null
    and (not exists (select 1 from public.app_admins)
         or exists (select 1 from public.app_admins where email = lower(auth.jwt() ->> 'email'))),
    false)
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- Keep updated_at current ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['staff', 'ambulances', 'routes', 'deployments', 'app_settings'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------- Access rules ----------
-- Signed-in admins (Supabase Auth users on the admin list) can read and edit everything.
-- Anyone else (including the QR team page) cannot read any table directly;
-- the team page only goes through the three team_* functions below,
-- and only for the one deployment whose secret link it holds.
do $$
declare t text;
begin
  foreach t in array array['staff', 'ambulances', 'routes', 'deployments', 'pings', 'pop_grid', 'app_settings', 'app_admins'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to authenticated;

-- ---------- Team page functions (QR link) ----------
create or replace function public.team_view(d public.deployments) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'date', d.dep_date, 'start_time', d.start_time, 'end_time', d.end_time,
    'status', d.status, 'plan', d.plan, 'progress', d.progress, 'last_seen', d.last_seen,
    'reg_no', a.reg_no, 'type', a.type,
    'pilot', case when p.id is null then null else jsonb_build_object('name', p.name, 'phone', p.phone) end,
    'emt',   case when e.id is null then null else jsonb_build_object('name', e.name, 'phone', e.phone) end,
    'now', now())
  from public.ambulances a
  left join public.staff p on p.id = d.pilot_id
  left join public.staff e on e.id = d.emt_id
  where a.id = d.ambulance_id
$$;

create or replace function public.team_get(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.deployments;
begin
  if p_token is null or length(p_token) < 24 then return null; end if;
  select * into d from public.deployments where token = p_token;
  if not found or d.status = 'Cancelled' then return null; end if;
  return public.team_view(d);
end $$;

-- p_kind: arr (reached), halt (halt started), dep (departed), undo, complete
create or replace function public.team_event(p_token text, p_stop int, p_kind text, p_at timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d public.deployments; pr jsonb; st jsonb; ev jsonb; n int; at timestamptz; k text; last_i int := -1; i int;
begin
  select * into d from public.deployments where token = p_token for update;
  if not found or d.status = 'Cancelled' then raise exception 'This deployment link is not valid any more'; end if;
  if p_kind not in ('arr', 'halt', 'dep', 'undo', 'complete') then raise exception 'Unknown action'; end if;
  n := coalesce(jsonb_array_length(d.plan -> 'stops'), 0);
  at := case when p_at is null or p_at > now() + interval '5 minutes' or p_at < now() - interval '24 hours' then now() else p_at end;
  pr := coalesce(d.progress, '{}'::jsonb);
  st := coalesce(pr -> 'stops', '{}'::jsonb);

  if p_kind = 'undo' then
    if pr ? 'done' then
      pr := pr - 'done';
    else
      for i in reverse n - 1 .. 0 loop
        if st ? i::text and st -> i::text <> '{}'::jsonb then last_i := i; exit; end if;
      end loop;
      if last_i >= 0 then
        ev := st -> last_i::text;
        foreach k in array array['dep', 'halt', 'arr'] loop
          if ev ? k then ev := ev - k; exit; end if;
        end loop;
        st := st || jsonb_build_object(last_i::text, ev);
      end if;
      pr := pr || jsonb_build_object('stops', st);
    end if;
  elsif p_kind = 'complete' then
    pr := pr || jsonb_build_object('done', at);
  else
    if p_stop is null or p_stop < 0 or p_stop >= n then raise exception 'Unknown stop'; end if;
    ev := coalesce(st -> p_stop::text, '{}'::jsonb);
    if not ev ? p_kind then ev := ev || jsonb_build_object(p_kind, at); end if;
    if p_kind in ('halt', 'dep') and not ev ? 'arr' then ev := ev || jsonb_build_object('arr', at); end if;
    st := st || jsonb_build_object(p_stop::text, ev);
    pr := pr || jsonb_build_object('stops', st);
  end if;

  update public.deployments set
    progress = pr,
    status = case
      when pr ? 'done' then 'Completed'
      when pr -> 'stops' is not null and exists (select 1 from jsonb_each(pr -> 'stops') x where x.value <> '{}'::jsonb) then 'In progress'
      when d.status in ('In progress', 'Completed') then 'Assigned'
      else d.status end
  where id = d.id
  returning * into d;
  return public.team_view(d);
end $$;

create or replace function public.team_ping(p_token text, p_lat double precision, p_lng double precision, p_acc double precision default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.deployments;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return false; end if;
  select * into d from public.deployments where token = p_token;
  if not found or d.status in ('Cancelled', 'Completed') then return false; end if;
  update public.deployments set last_lat = p_lat, last_lng = p_lng, last_acc = p_acc, last_seen = now() where id = d.id;
  if not exists (select 1 from public.pings where deployment_id = d.id and at > now() - interval '25 seconds') then
    insert into public.pings(deployment_id, lat, lng, acc) values (d.id, p_lat, p_lng, p_acc);
  end if;
  return true;
end $$;

revoke all on function public.team_view(public.deployments) from public, anon, authenticated;
grant execute on function public.team_get(text) to anon, authenticated;
grant execute on function public.team_event(text, int, text, timestamptz) to anon, authenticated;
grant execute on function public.team_ping(text, double precision, double precision, double precision) to anon, authenticated;
