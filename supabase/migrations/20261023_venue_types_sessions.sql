-- Migration 2026-10-23: venue types, good_for, recurring sessions.
-- Paste into the Supabase SQL editor once. Safe to paste again.
-- Adds venues.venue_type, venues.good_for, venues.source_url, a public
-- recurring_sessions table, and replaces search_venues with the same
-- arguments plus venue_type, good_for, source_url and sessions in each row.
-- No rows are deleted. Fill the data with scripts/apply_public_data.mjs.

set search_path = public, extensions;

alter table public.venues add column if not exists venue_type text;
alter table public.venues add column if not exists good_for text[] not null default '{}';
alter table public.venues add column if not exists source_url text;

alter table public.venues drop constraint if exists venues_type;
alter table public.venues add constraint venues_type check (venue_type is null or venue_type in (
  'cafe', 'coworking', 'library', 'community_space', 'bar', 'hotel', 'private_room',
  'studio', 'office', 'campus', 'hall', 'shop', 'outdoor', 'other'
));
alter table public.venues drop constraint if exists venues_good_for;
alter table public.venues add constraint venues_good_for check (
  good_for <@ array['coworking', 'community_event', 'private_party', 'workshop']::text[]
);

comment on column public.venues.venue_type is
  'What kind of place it is. Null means not checked yet.';
comment on column public.venues.good_for is
  'Use cases the venue suits: coworking, community_event, private_party, workshop.';
comment on column public.venues.source_url is
  'Public page the type, hours or capacity came from.';

create table if not exists public.recurring_sessions (
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

create index if not exists recurring_sessions_venue_idx on public.recurring_sessions (venue_id);

alter table public.recurring_sessions enable row level security;
drop policy if exists recurring_sessions_select on public.recurring_sessions;
create policy recurring_sessions_select on public.recurring_sessions
  for select
  using (true);
revoke all on table public.recurring_sessions from public, anon, authenticated;
grant select on public.recurring_sessions to anon, authenticated;

grant select (venue_type, good_for, source_url) on public.venues to anon, authenticated;

drop view if exists public.venues_public;
create view public.venues_public
with (security_invoker = true, security_barrier = true) as
select
  id, name, address, lat, lng, capacity, guest_count_lower_bound, has_av, av_notes,
  hours, evening_hours, weekend_hours, terms, notes, status, created_by, source,
  seed_key, venue_type, good_for, source_url, created_at, updated_at
from public.venues;
comment on view public.venues_public is
  'Venue rows safe for the map and for anon. Omits contact. Pending rows from a revoked organiser are hidden.';
revoke all on table public.venues_public from public, anon, authenticated;
grant select on public.venues_public to anon, authenticated;

-- search.sql from here, so search_venues returns the new fields.
create or replace function public.normalise_day(day_of_week text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  d text := lower(btrim(coalesce(day_of_week, '')));
begin
  if d = '' then
    return null;
  end if;
  if d in ('0', '7', 'sun', 'sunday') then return 'sun'; end if;
  if d in ('1', 'mon', 'monday') then return 'mon'; end if;
  if d in ('2', 'tue', 'tues', 'tuesday') then return 'tue'; end if;
  if d in ('3', 'wed', 'wednesday') then return 'wed'; end if;
  if d in ('4', 'thu', 'thur', 'thurs', 'thursday') then return 'thu'; end if;
  if d in ('5', 'fri', 'friday') then return 'fri'; end if;
  if d in ('6', 'sat', 'saturday') then return 'sat'; end if;
  raise exception 'day_of_week must be a day name (thu, Thursday) or 0-6 where 0 is Sunday. Got "%".', day_of_week
    using errcode = '22023';
end;
$$;

-- skip: no day was requested. unknown: venue has no hours.
-- open_evening / open: the requested slot sits inside the window.
-- closed: the venue has hours, and this slot is outside them.
create or replace function public.hours_state(
  hours jsonb,
  day_key text,
  start_time time
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  slot jsonb;
  w_start time;
  w_end time;
begin
  if day_key is null then
    return 'skip';
  end if;
  if hours is null or hours = '{}'::jsonb then
    return 'unknown';
  end if;
  if not (hours ? day_key) then
    return 'closed';
  end if;

  slot := hours -> day_key;
  begin
    w_start := (slot ->> 'start')::time;
    w_end := (slot ->> 'end')::time;
  exception
    when others then
      return 'unknown';
  end;

  if w_start is null or w_end is null or w_end <= w_start then
    return 'unknown';
  end if;
  if start_time is not null and (start_time < w_start or start_time >= w_end) then
    return 'closed';
  end if;
  if w_start >= time '17:00' then
    return 'open_evening';
  end if;
  return 'open';
end;
$$;

-- A composite type so the arguments can be named lat/lng and the JSON
-- rows can also expose lat/lng. Postgres rejects a function that uses the
-- same name for an argument and a RETURNS TABLE column.
drop function if exists public.search_venues(double precision, double precision, integer, integer, text, time, integer);
drop type if exists public.search_venue_result;

create type public.search_venue_result as (
  id uuid,
  name text,
  address text,
  lat double precision,
  lng double precision,
  capacity integer,
  has_av boolean,
  av_notes text,
  terms text,
  hours jsonb,
  evening_hours text,
  weekend_hours text,
  notes text,
  status text,
  hosting_count integer,
  largest_guest_count integer,
  distance_m double precision,
  score numeric,
  reason text,
  venue_type text,
  good_for text[],
  source_url text,
  sessions jsonb
);

create or replace function public.search_venues(
  lat double precision,
  lng double precision,
  radius_m integer,
  min_capacity integer default null,
  day_of_week text default null,
  start_time time default null,
  max_results integer default 3
)
returns setof public.search_venue_result
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  q_lat double precision := lat;
  q_lng double precision := lng;
  q_radius integer := radius_m;
  q_min integer := min_capacity;
  q_start time := start_time;
  q_limit integer := least(greatest(coalesce(max_results, 3), 1), 20);
  day_key text := public.normalise_day(day_of_week);
  day_label text;
begin
  if q_lat is null or q_lng is null or q_radius is null then
    raise exception 'search_venues needs lat, lng and radius_m';
  end if;
  if q_radius <= 0 then
    raise exception 'radius_m must be greater than 0';
  end if;
  if q_lat < -90 or q_lat > 90 or q_lng < -180 or q_lng > 180 then
    raise exception 'lat must be between -90 and 90 and lng between -180 and 180';
  end if;

  day_label := case day_key
    when 'mon' then 'Mon'
    when 'tue' then 'Tue'
    when 'wed' then 'Wed'
    when 'thu' then 'Thu'
    when 'fri' then 'Fri'
    when 'sat' then 'Sat'
    when 'sun' then 'Sun'
    else null
  end;

  return query
  with origin as (
    select st_setsrid(st_makepoint(q_lng, q_lat), 4326)::geography as geog
  ),
  visible as (
    select v.*
    from public.venues v
    where v.status = 'verified'
      or public.is_vouched(auth.uid())
      or (v.status = 'pending' and public.is_vouched(v.created_by))
  ),
  nearby as (
    select
      v.*,
      st_distance(v.location, o.geog) as dist_m
    from visible v
    cross join origin o
    where st_dwithin(v.location, o.geog, q_radius)
      and (
        q_min is null
        or v.capacity is null
        or v.capacity >= q_min
      )
  ),
  hosted as (
    select
      h.venue_id,
      count(*)::integer as event_count,
      max(h.guest_count) filter (where h.guest_count > 0)::integer as largest
    from public.hosted_events h
    group by h.venue_id
  ),
  -- Recurring public sessions (Co-Working Fridays and so on) per venue.
  -- on_slot is true when one runs on the requested day and, if a time was
  -- given, is running at that time.
  sess as (
    select
      r.venue_id,
      jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'title', r.title,
          'organiser', r.organiser,
          'use_case', r.use_case,
          'day_of_week', r.day_of_week,
          'start_time', to_char(r.start_time, 'HH24:MI'),
          'end_time', to_char(r.end_time, 'HH24:MI'),
          'cadence', r.cadence,
          'price', r.price,
          'rsvp', r.rsvp,
          'url', r.url,
          'source_url', r.source_url,
          'summary', r.summary
        )
        order by r.day_of_week, r.start_time
      ) as items,
      bool_or(
        day_key is not null
        and r.day_of_week = day_key
        and (q_start is null or (q_start >= r.start_time and q_start < r.end_time))
      ) as on_slot
    from public.recurring_sessions r
    group by r.venue_id
  ),
  scored as (
    select
      n.id as venue_id,
      n.name as venue_name,
      n.address as venue_address,
      n.lat as venue_lat,
      n.lng as venue_lng,
      n.capacity as venue_capacity,
      n.has_av as venue_has_av,
      n.av_notes as venue_av_notes,
      n.terms as venue_terms,
      n.hours as venue_hours,
      n.evening_hours as venue_evening_hours,
      n.weekend_hours as venue_weekend_hours,
      n.notes as venue_notes,
      n.status as venue_status,
      n.venue_type as venue_kind,
      n.good_for as venue_good_for,
      n.source_url as venue_source_url,
      se.items as venue_sessions,
      coalesce(se.on_slot, false) as on_slot,
      n.dist_m,
      coalesce(h.event_count, 0) as event_count,
      h.largest,
      public.hours_state(n.hours, day_key, q_start) as slot,
      case
        when n.capacity is not null
          and public.hours_state(n.hours, day_key, q_start) in ('open_evening', 'open', 'skip')
          then 70
        when n.capacity is not null
          and public.hours_state(n.hours, day_key, q_start) = 'unknown'
          then 50
        when n.capacity is null
          and public.hours_state(n.hours, day_key, q_start) in ('open_evening', 'open')
          then 40
        when n.capacity is null
          and public.hours_state(n.hours, day_key, q_start) in ('skip', 'unknown')
          then 30
        when n.capacity is not null
          then 20
        else 10
      end
      + case when coalesce(se.on_slot, false) then 100 else 0 end as fit_rank
    from nearby n
    left join hosted h on h.venue_id = n.id
    left join sess se on se.venue_id = n.id
  )
  select
    s.venue_id,
    s.venue_name,
    s.venue_address,
    s.venue_lat,
    s.venue_lng,
    s.venue_capacity,
    s.venue_has_av,
    s.venue_av_notes,
    s.venue_terms,
    s.venue_hours,
    s.venue_evening_hours,
    s.venue_weekend_hours,
    s.venue_notes,
    s.venue_status,
    s.event_count,
    s.largest,
    s.dist_m,
    (
      s.fit_rank::numeric * 1000000000
      + s.event_count::numeric * 1000000
      + coalesce(s.largest, 0)::numeric * 1000
      + greatest(0::numeric, 100000::numeric - least(s.dist_m, 99999::double precision)::numeric)
    )::numeric as score,
    concat_ws(
      ' · ',
      case when s.on_slot then 'recurring session that day' end,
      case
        when s.venue_capacity is null then 'capacity unknown'
        when q_min is not null and s.venue_capacity >= q_min then 'fits ' || q_min::text
        else 'capacity ' || s.venue_capacity::text
      end,
      case s.slot
        when 'skip' then null
        when 'unknown' then 'hours unknown'
        when 'open_evening' then 'open ' || day_label || ' evenings'
        when 'open' then 'open ' || day_label || ' '
          || (s.venue_hours -> day_key ->> 'start') || '–'
          || (s.venue_hours -> day_key ->> 'end')
        else 'closed ' || day_label
          || case
            when q_start is null then ''
            else ' at ' || to_char(q_start, 'HH24:MI')
          end
      end,
      case
        when s.event_count = 0 then 'no community events yet'
        when s.largest is null then 'hosted ' || s.event_count::text
          || case when s.event_count = 1 then ' community event' else ' community events' end
        else 'hosted ' || s.event_count::text
          || case when s.event_count = 1 then ' community event' else ' community events' end
          || ', largest ' || s.largest::text
      end
    ) as reason,
    s.venue_kind,
    s.venue_good_for,
    s.venue_source_url,
    coalesce(s.venue_sessions, '[]'::jsonb)
  from scored s
  order by s.fit_rank desc, s.event_count desc, coalesce(s.largest, 0) desc, s.dist_m asc
  limit q_limit;
end;
$$;

comment on function public.search_venues(double precision, double precision, integer, integer, text, time, integer) is
  'Top venues within radius_m of (lat, lng). Ranked by recurring session on the slot, fit, past hosting, then distance. Returns venue_type, good_for and sessions. Does not return contact.';

revoke all on function public.search_venues(double precision, double precision, integer, integer, text, time, integer) from public;
grant execute on function public.search_venues(double precision, double precision, integer, integer, text, time, integer) to anon, authenticated, service_role, postgres;
