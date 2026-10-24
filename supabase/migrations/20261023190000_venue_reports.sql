-- Organiser details per venue: what it costs, access, toilets, AV, wifi, capacity, latest finish,
-- and a private booking contact. One report per signed-in organiser per venue (they can update it);
-- a separate 'public_source' report per venue holds facts copied from the venue's own website.
-- Everyone can read the non-contact fields and the aggregate (venue_details). Booking contacts live in
-- their own table and are readable only by their author and by vouched organisers.

-- 1. Reports -----------------------------------------------------------------
create table public.venue_reports (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id) on delete cascade,
  author uuid default auth.uid() references auth.users (id) on delete cascade,
  source text not null default 'organiser' check (source in ('organiser', 'public_source')),
  source_url text check (source_url is null or source_url ~ '^https?://'),
  hosted_here boolean not null default true,
  price_kind text check (price_kind in ('free', 'sponsored', 'paid', 'minimum_spend')),
  price_min integer check (price_min between 0 and 100000),
  price_max integer check (price_max between 0 and 100000),
  price_note text check (char_length(price_note) <= 300),
  step_free text check (step_free in ('yes', 'partial', 'no')),
  accessible_toilet boolean,
  toilets_count smallint check (toilets_count between 0 and 500),
  projector boolean,
  microphones boolean,
  wifi boolean,
  guest_wifi_ok boolean,
  capacity_seated integer check (capacity_seated between 1 and 20000),
  capacity_standing integer check (capacity_standing between 1 and 20000),
  latest_finish time,
  has_booking_contact boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint venue_reports_price_range check (price_max is null or price_min is null or price_max >= price_min),
  constraint venue_reports_author_matches_source check ((source = 'organiser') = (author is not null)),
  constraint venue_reports_public_source_has_url check (source <> 'public_source' or source_url is not null)
);
comment on table public.venue_reports is 'Organiser-confirmed (or venue-website) details per venue. Booking contacts are in venue_report_contacts.';
create unique index venue_reports_one_per_author on public.venue_reports (venue_id, author) where author is not null;
create unique index venue_reports_one_public_source on public.venue_reports (venue_id) where source = 'public_source';
create index venue_reports_author on public.venue_reports (author);
alter table public.venue_reports enable row level security;

-- 2. Private booking contacts --------------------------------------------------
-- A general booking email, an enquiry form URL, or a role ("events team"); never a personal phone.
create table public.venue_report_contacts (
  report_id uuid primary key references public.venue_reports (id) on delete cascade,
  venue_id uuid not null references public.venues (id) on delete cascade,
  author uuid default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('email', 'form', 'role')),
  value text not null check (char_length(value) between 3 and 200),
  updated_at timestamptz not null default now(),
  constraint venue_report_contacts_no_phone check (value !~ '\+?\d[\d\s().-]{7,}\d'),
  constraint venue_report_contacts_email check (kind <> 'email' or value ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  constraint venue_report_contacts_form check (kind <> 'form' or value ~ '^https?://')
);
comment on table public.venue_report_contacts is 'Private: readable by the author and by vouched organisers only.';
create index venue_report_contacts_venue on public.venue_report_contacts (venue_id);
create index venue_report_contacts_author on public.venue_report_contacts (author);
alter table public.venue_report_contacts enable row level security;

-- 3. Who may see booking contacts: organisers reached through the vouch graph, or anyone with at
-- least one venue/session that two other organisers vouched for (verified submission).
create or replace function private.can_see_booking_contacts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private.is_vouched(auth.uid())
    or exists (select 1 from public.submissions s where s.submitter = auth.uid() and s.status = 'verified')
  );
$$;
revoke all on function private.can_see_booking_contacts() from public;
grant execute on function private.can_see_booking_contacts() to authenticated;

create or replace function public.can_see_booking_contacts()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.can_see_booking_contacts() $$;
revoke execute on function public.can_see_booking_contacts() from public, anon;
grant execute on function public.can_see_booking_contacts() to authenticated;

-- 4. Privileges -----------------------------------------------------------------
revoke all on public.venue_reports, public.venue_report_contacts from anon, authenticated;
grant select on public.venue_reports to anon, authenticated;
grant insert (venue_id, hosted_here, price_kind, price_min, price_max, price_note, step_free, accessible_toilet,
              toilets_count, projector, microphones, wifi, guest_wifi_ok, capacity_seated, capacity_standing, latest_finish)
  on public.venue_reports to authenticated;
grant update (hosted_here, price_kind, price_min, price_max, price_note, step_free, accessible_toilet,
              toilets_count, projector, microphones, wifi, guest_wifi_ok, capacity_seated, capacity_standing, latest_finish)
  on public.venue_reports to authenticated;
grant delete on public.venue_reports to authenticated;
grant select, delete on public.venue_report_contacts to authenticated;
grant insert (report_id, venue_id, kind, value) on public.venue_report_contacts to authenticated;
grant update (kind, value) on public.venue_report_contacts to authenticated;

create policy "Anyone can read venue reports" on public.venue_reports
  for select to anon, authenticated using (true);
create policy "Signed-in organisers add their own report" on public.venue_reports
  for insert to authenticated
  with check (author = (select auth.uid()) and source = 'organiser');
create policy "Authors update their own report" on public.venue_reports
  for update to authenticated
  using (author = (select auth.uid()))
  with check (author = (select auth.uid()) and source = 'organiser');
create policy "Authors delete their own report" on public.venue_reports
  for delete to authenticated
  using (author = (select auth.uid()));

create policy "Authors and vouched organisers read booking contacts" on public.venue_report_contacts
  for select to authenticated
  using (author = (select auth.uid()) or (select private.can_see_booking_contacts()));
create policy "Authors add a contact to their own report" on public.venue_report_contacts
  for insert to authenticated
  with check (
    author = (select auth.uid())
    and exists (select 1 from public.venue_reports r
                 where r.id = report_id and r.author = (select auth.uid()) and r.venue_id = venue_report_contacts.venue_id)
  );
create policy "Authors update their own contact" on public.venue_report_contacts
  for update to authenticated
  using (author = (select auth.uid()))
  with check (author = (select auth.uid()));
create policy "Authors delete their own contact" on public.venue_report_contacts
  for delete to authenticated
  using (author = (select auth.uid()));

-- 5. Guards -----------------------------------------------------------------------
-- Author and source always come from the session; at most 30 new reports per user per day.
create or replace function private.guard_venue_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  recent integer;
begin
  if me is null and current_user in ('postgres', 'supabase_admin', 'service_role') then
    new.updated_at := now();
    return new;
  end if;
  -- The contact-sync trigger below updates has_booking_contact on the caller's behalf.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    return new;
  end if;
  if me is null then
    raise exception 'Sign in to share venue details' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    new.author := me;
    new.source := 'organiser';
    new.source_url := null;
    new.has_booking_contact := false;
    select count(*) into recent from public.venue_reports where author = me and created_at > now() - interval '24 hours';
    if recent >= 30 then
      raise exception 'You can report on up to 30 venues a day. Try again tomorrow.' using errcode = 'check_violation';
    end if;
  else
    new.author := old.author;
    new.source := old.source;
    new.source_url := old.source_url;
    new.venue_id := old.venue_id;
    new.has_booking_contact := old.has_booking_contact;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.guard_venue_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null and current_user in ('postgres', 'supabase_admin', 'service_role') then
    new.updated_at := now();
    return new;
  end if;
  if auth.uid() is null then
    raise exception 'Sign in to share a booking contact' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    new.author := auth.uid();
  else
    new.author := old.author;
    new.report_id := old.report_id;
    new.venue_id := old.venue_id;
  end if;
  new.value := btrim(new.value);
  new.updated_at := now();
  return new;
end;
$$;

-- Keep venue_reports.has_booking_contact in sync so everyone can see that a contact exists.
create or replace function private.sync_has_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.venue_reports r
     set has_booking_contact = exists (select 1 from public.venue_report_contacts c where c.report_id = r.id)
   where r.id = coalesce(new.report_id, old.report_id);
  return null;
end;
$$;

revoke all on function private.guard_venue_report() from public, anon, authenticated;
revoke all on function private.guard_venue_contact() from public, anon, authenticated;
revoke all on function private.sync_has_contact() from public, anon, authenticated;

create trigger venue_reports_guard before insert or update on public.venue_reports
  for each row execute function private.guard_venue_report();
create trigger venue_report_contacts_guard before insert or update on public.venue_report_contacts
  for each row execute function private.guard_venue_contact();
create trigger venue_report_contacts_sync after insert or delete on public.venue_report_contacts
  for each row execute function private.sync_has_contact();

-- 6. Aggregate: one row per venue, field and source with the most-confirmed value. ----------------
create or replace view public.venue_details
with (security_invoker = true)
as
with facts as (
  select r.venue_id, r.source, r.source_url, f.key as field, f.value, r.updated_at
    from public.venue_reports r
   cross join lateral jsonb_each(jsonb_strip_nulls(jsonb_build_object(
     'hosted_here', case when r.source = 'organiser' and r.hosted_here then true end,
     'price', case when r.price_kind is not null then jsonb_strip_nulls(jsonb_build_object('kind', r.price_kind, 'min', r.price_min, 'max', r.price_max)) end,
     'price_note', r.price_note,
     'step_free', r.step_free,
     'accessible_toilet', r.accessible_toilet,
     'toilets_count', r.toilets_count,
     'projector', r.projector,
     'microphones', r.microphones,
     'wifi', r.wifi,
     'guest_wifi_ok', r.guest_wifi_ok,
     'capacity_seated', r.capacity_seated,
     'capacity_standing', r.capacity_standing,
     'latest_finish', to_char(r.latest_finish, 'HH24:MI'),
     'booking_contact', case when r.has_booking_contact then true end
   ))) f
),
grouped as (
  select venue_id, source, field, value, count(*) as confirmations, max(updated_at) as last_updated, min(source_url) as source_url
    from facts
   group by venue_id, source, field, value
),
ranked as (
  select g.*,
         sum(g.confirmations) over (partition by g.venue_id, g.source, g.field) as reports,
         row_number() over (partition by g.venue_id, g.source, g.field order by g.confirmations desc, g.last_updated desc) as rk
    from grouped g
)
select venue_id, field, source, value, confirmations::integer, reports::integer, last_updated, source_url
  from ranked
 where rk = 1;
revoke all on public.venue_details from anon, authenticated;
grant select on public.venue_details to anon, authenticated;
