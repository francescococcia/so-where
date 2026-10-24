-- Lumap schema. Paste into the Supabase SQL editor after PostGIS is enabled.
-- Re-running this file drops the Lumap tables and recreates them.
-- Then run policies.sql, search.sql, and seed.sql. See supabase/README.md.

create schema if not exists extensions;

create extension if not exists postgis with schema extensions;

set search_path = public, extensions;

-- Drop in dependency order so this file can be pasted again during setup.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'search_venues',
        'normalise_day',
        'hours_state',
        'venue_contact',
        'is_vouched',
        'caller_organiser',
        'email_is_root',
        'enforce_venue_write',
        'enforce_vouch_write',
        'protect_organiser_flags',
        'handle_new_user'
      )
  loop
    execute 'drop function if exists ' || r.sig || ' cascade';
  end loop;
end $$;

drop view if exists public.venues_organiser;
drop view if exists public.venues_public;
drop type if exists public.search_venue_result;

drop table if exists public.recurring_sessions cascade;
drop table if exists public.hosted_events cascade;
drop table if exists public.venues cascade;
drop table if exists public.vouches cascade;
drop table if exists public.communities cascade;
drop table if exists public.organisers cascade;
drop table if exists public.root_emails cascade;

-- Emails of root organisers. config/city.json is the source; seed.sql copies it here.
-- handle_new_user (in policies.sql) marks a signup as root when the email matches.
create table public.root_emails (
  email text primary key,
  display_name text not null
);

create table public.organisers (
  id uuid primary key,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  email text unique,
  display_name text not null,
  is_root boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.organisers is
  'One row per organiser. id is stable; auth_user_id is set when they sign up. Roots are vouched without a vouch row.';

create table public.vouches (
  id uuid primary key default gen_random_uuid(),
  voucher uuid not null references public.organisers (id) on delete cascade,
  vouchee uuid not null references public.organisers (id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint vouches_not_self check (voucher <> vouchee),
  constraint vouches_pair unique (voucher, vouchee)
);

comment on table public.vouches is
  'A vouch counts only while revoked_at is null. Revoke by setting revoked_at; it takes effect on the next is_vouched call.';

create index vouches_active_voucher_idx
  on public.vouches (voucher)
  where revoked_at is null;

create index vouches_vouchee_idx
  on public.vouches (vouchee);

create table public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  luma_calendar_id text,
  notes text,
  created_at timestamptz not null default now()
);

create unique index communities_luma_calendar_idx
  on public.communities (luma_calendar_id)
  where luma_calendar_id is not null;

-- hours jsonb keys are sun, mon, tue, wed, thu, fri, sat.
-- Each value is {"start": "18:00", "end": "22:00"} using 24-hour HH:MM.
-- {} means the hours are unknown. A missing day means closed that day.
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  lat double precision not null,
  lng double precision not null,
  location geography(Point, 4326) generated always as (
    st_setsrid(st_makepoint(lng, lat), 4326)::geography
  ) stored,
  capacity integer,
  guest_count_lower_bound integer,
  has_av boolean,
  av_notes text,
  hours jsonb not null default '{}'::jsonb,
  evening_hours text,
  weekend_hours text,
  terms text,
  contact text,
  notes text,
  status text not null default 'pending',
  created_by uuid references public.organisers (id) on delete set null,
  source text,
  seed_key text unique,
  venue_type text,
  good_for text[] not null default '{}',
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint venues_capacity_nonnegative check (capacity is null or capacity >= 0),
  constraint venues_lower_bound_nonnegative check (
    guest_count_lower_bound is null or guest_count_lower_bound >= 0
  ),
  constraint venues_status check (status in ('pending', 'verified')),
  constraint venues_hours_object check (jsonb_typeof(hours) = 'object'),
  constraint venues_lat check (lat between -90 and 90),
  constraint venues_lng check (lng between -180 and 180),
  constraint venues_type check (venue_type is null or venue_type in (
    'cafe', 'coworking', 'library', 'community_space', 'bar', 'hotel', 'private_room',
    'studio', 'office', 'campus', 'hall', 'shop', 'outdoor', 'other'
  )),
  constraint venues_good_for check (
    good_for <@ array['coworking', 'community_event', 'private_party', 'workshop']::text[]
  )
);

comment on column public.venues.venue_type is
  'What kind of place it is. Null means not checked yet.';

comment on column public.venues.good_for is
  'Use cases the venue suits: coworking, community_event, private_party, workshop.';

comment on column public.venues.source_url is
  'Public page the type, hours or capacity came from.';

comment on column public.venues.capacity is
  'Verified capacity. Null means unknown. Luma RSVP counts are not stored here.';

comment on column public.venues.guest_count_lower_bound is
  'Largest Luma RSVP count seen at this address. Not a capacity.';

comment on column public.venues.contact is
  'Hidden from unvouched callers. Read venues_organiser or venue_contact(), both defined in policies.sql.';

comment on column public.venues.terms is
  'How a community can use the room, in the organiser''s words. Ask them to confirm availability.';

comment on column public.venues.hours is
  'Weekly windows. Keys sun..sat, values {"start":"HH:MM","end":"HH:MM"}. Empty object means hours unknown.';

create index venues_location_gix on public.venues using gist (location);
create index venues_status_idx on public.venues (status);
create index venues_created_by_idx on public.venues (created_by);

create table public.hosted_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id) on delete cascade,
  community_id uuid references public.communities (id) on delete set null,
  community_name text not null,
  event_name text not null,
  event_date timestamptz not null,
  guest_count integer,
  source text,
  url text,
  external_id text unique,
  created_at timestamptz not null default now(),
  constraint hosted_events_guests_nonnegative check (guest_count is null or guest_count >= 0)
);

comment on column public.hosted_events.event_date is
  'When the event started. Named event_date so it does not clash with the date type.';

create index hosted_events_venue_idx on public.hosted_events (venue_id);
create index hosted_events_date_idx on public.hosted_events (event_date desc);
create index hosted_events_community_idx on public.hosted_events (community_id);

-- Public recurring sessions at a venue, e.g. Co-Working Fridays at Somerset House.
create table public.recurring_sessions (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id) on delete cascade,
  session_key text unique,
  title text not null,
  organiser text,
  use_case text not null,
  day_of_week text not null,
  start_time time not null,
  end_time time not null,
  cadence text,
  price text,
  rsvp text,
  url text,
  source_url text not null,
  summary text,
  verified_at date,
  created_at timestamptz not null default now(),
  constraint recurring_sessions_use_case check (use_case in ('meetup', 'cowork', 'party', 'workshop')),
  constraint recurring_sessions_day check (day_of_week in ('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat')),
  constraint recurring_sessions_times check (end_time > start_time)
);

create index recurring_sessions_venue_idx on public.recurring_sessions (venue_id);
