-- Shared review queue: community-submitted venues and cowork sessions, vouched by organisers.
-- Replaces the per-browser localStorage queue so everyone sees the same submissions.
-- Public data only: no names, emails or phone numbers of the people submitting.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('venue', 'session')),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  name text not null check (char_length(btrim(name)) between 2 and 120),        -- venue name or session title
  organiser text check (char_length(organiser) <= 120),                         -- community or organisation, not a person's contact
  venue_name text check (char_length(venue_name) <= 120),
  address text check (char_length(address) <= 200),
  area text check (char_length(area) <= 60),
  capacity integer check (capacity between 1 and 5000),
  day_of_week text check (day_of_week in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  start_time time,
  end_time time,
  price text check (char_length(price) <= 60),
  url text check (url is null or (char_length(url) <= 300 and url ~* '^https?://[^[:space:]]+$')),
  note text check (char_length(note) <= 500),
  lat double precision not null check (lat between 51.25 and 51.75),            -- Greater London
  lng double precision not null check (lng between -0.55 and 0.35),
  submitted_by text not null check (submitted_by ~ '^[A-Za-z0-9-]{8,64}$'),    -- random per-browser id, not personal data
  vouch_count integer not null default 0,
  reject_count integer not null default 0,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint submissions_session_fields check (
    kind <> 'session' or (day_of_week is not null and start_time is not null and end_time is not null and end_time > start_time)
  ),
  constraint submissions_no_contact_details check (
    concat_ws(' ', name, organiser, venue_name, address, price, note) !~* '[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z.]{2,}'
    and concat_ws(' ', name, organiser, venue_name, address, price, note) !~ '(\+44[ ]?|\m0)7[0-9]{3}[ ]?[0-9]{3}[ ]?[0-9]{3}'
  )
);

-- One open submission per name/kind (stops the same thing being queued again and again).
create unique index submissions_pending_unique on public.submissions (kind, lower(btrim(name)), coalesce(day_of_week, '')) where status = 'pending';
create index submissions_status_created on public.submissions (status, created_at desc);

create table public.submission_vouches (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  voter text not null check (voter ~ '^[A-Za-z0-9-]{8,64}$'),                   -- random per-browser id
  vote text not null default 'vouch' check (vote in ('vouch', 'reject')),
  created_at timestamptz not null default now(),
  constraint submission_vouches_one_per_voter unique (submission_id, voter)
);

-- Row level security: anyone can read; anyone can add a pending submission or a vote; nobody updates or deletes.
alter table public.submissions enable row level security;
alter table public.submission_vouches enable row level security;

revoke all on public.submissions, public.submission_vouches from anon, authenticated;
grant select on public.submissions, public.submission_vouches to anon, authenticated;
grant insert (kind, name, organiser, venue_name, address, area, capacity, day_of_week, start_time, end_time, price, url, note, lat, lng, submitted_by)
  on public.submissions to anon, authenticated;
grant insert (submission_id, voter, vote) on public.submission_vouches to anon, authenticated;

create policy "Anyone can read submissions" on public.submissions
  for select to anon, authenticated using (true);
create policy "Anyone can submit a pending venue or session" on public.submissions
  for insert to anon, authenticated
  with check (status = 'pending' and vouch_count = 0 and reject_count = 0 and decided_at is null);

create policy "Anyone can read votes" on public.submission_vouches
  for select to anon, authenticated using (true);
create policy "Anyone can vote once on a pending submission" on public.submission_vouches
  for insert to anon, authenticated
  with check (exists (select 1 from public.submissions s where s.id = submission_id and s.status = 'pending'));

-- Guards that RLS alone can't express: no voting on your own submission, no votes after a decision.
create or replace function private.check_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.submissions%rowtype;
begin
  select * into s from public.submissions where id = new.submission_id for update;
  if not found or s.status <> 'pending' then
    raise exception 'This submission has already been decided' using errcode = 'check_violation';
  end if;
  if s.submitted_by = new.voter then
    raise exception 'You cannot vouch for your own submission' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Flip status at 2 distinct vouches (verified) or 2 distinct rejections (rejected).
create or replace function private.tally_votes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  vouches integer;
  rejects integer;
begin
  select count(distinct voter) filter (where vote = 'vouch'),
         count(distinct voter) filter (where vote = 'reject')
    into vouches, rejects
    from public.submission_vouches
   where submission_id = new.submission_id;

  update public.submissions
     set vouch_count = vouches,
         reject_count = rejects,
         status = case when vouches >= 2 then 'verified' when rejects >= 2 then 'rejected' else 'pending' end,
         decided_at = case when vouches >= 2 or rejects >= 2 then now() else null end
   where id = new.submission_id
     and status = 'pending';
  return null;
end;
$$;

revoke all on function private.check_vote() from public, anon, authenticated;
revoke all on function private.tally_votes() from public, anon, authenticated;

create trigger submission_vouches_check before insert on public.submission_vouches
  for each row execute function private.check_vote();
create trigger submission_vouches_tally after insert on public.submission_vouches
  for each row execute function private.tally_votes();
