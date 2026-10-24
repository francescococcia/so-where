-- Lumap trust rules. Run after schema.sql, before search.sql and seed.sql.
--
-- An organiser is vouched if they are a root, or an unrevoked vouch chain
-- reaches them from a root. Revoke by setting vouches.revoked_at. The next
-- call sees it; nothing is cached.
--
-- Unvouched venue insert or update raises:
--   Only vouched organisers can post. Ask an organiser to vouch for you.

set search_path = public, extensions;

-- auth.uid() is what the policies call. Supabase already grants this; repeat it
-- so a fresh project still resolves the helper for anon and authenticated.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create or replace function public.is_vouched(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive reached as (
    select o.id
    from public.organisers o
    where o.is_root
    union
    select v.vouchee
    from public.vouches v
    join reached r on r.id = v.voucher
    where v.revoked_at is null
  )
  select coalesce(
    (
      select true
      from public.organisers o
      join reached r on r.id = o.id
      where uid is not null
        and (o.id = uid or o.auth_user_id = uid)
      limit 1
    ),
    false
  );
$$;

comment on function public.is_vouched(uuid) is
  'True when uid is an organiser id or auth user id that is a root, or has an unrevoked vouch from someone vouched.';

revoke all on function public.is_vouched(uuid) from public;
grant execute on function public.is_vouched(uuid) to anon, authenticated, service_role, postgres;

-- Lets invoker triggers read organiser flags without opening email or root_emails.
create or replace function public.caller_organiser()
returns table (id uuid, is_root boolean)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.is_root
  from public.organisers o
  where o.auth_user_id = auth.uid();
$$;

create or replace function public.email_is_root(address text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.root_emails r
    where address is not null
      and lower(r.email) = lower(address)
  );
$$;

revoke all on function public.caller_organiser() from public;
revoke all on function public.email_is_root(text) from public;
grant execute on function public.caller_organiser() to authenticated, service_role, postgres;
grant execute on function public.email_is_root(text) to authenticated, service_role, postgres;

-- Link a new auth user to a seeded root row, or create a non-root organiser.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  root_hit boolean;
  label text;
begin
  select exists (
    select 1
    from public.root_emails r
    where new.email is not null
      and lower(r.email) = lower(new.email)
  ) into root_hit;

  label := coalesce(
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Organiser'
  );

  update public.organisers
  set auth_user_id = new.id,
      is_root = is_root or root_hit,
      display_name = case
        when display_name like 'EXAMPLE %' then label
        else display_name
      end
  where new.email is not null
    and lower(email) = lower(new.email)
    and (auth_user_id is null or auth_user_id = new.id);

  if not found then
    insert into public.organisers (id, auth_user_id, email, display_name, is_root)
    values (new.id, new.id, new.email, label, root_hit);
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

create or replace function public.protect_organiser_flags()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'Sign in before creating an organiser profile.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    new.is_root := false;
    new.id := auth.uid();
    new.auth_user_id := auth.uid();
    if public.email_is_root(new.email) then
      raise exception 'That email is reserved for a root organiser.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  new.is_root := old.is_root;
  new.auth_user_id := old.auth_user_id;
  new.email := old.email;
  new.id := old.id;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists organisers_protect_flags on public.organisers;
create trigger organisers_protect_flags
  before insert or update on public.organisers
  for each row
  execute function public.protect_organiser_flags();

create or replace function public.enforce_vouch_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  me uuid;
  caller_is_root boolean;
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  select c.id, c.is_root
  into me, caller_is_root
  from public.caller_organiser() c;

  if me is null or not public.is_vouched(auth.uid()) then
    raise exception 'Only vouched organisers can vouch. Ask an organiser to vouch for you.'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.voucher is distinct from me then
      raise exception 'You can only vouch as yourself.'
        using errcode = '42501';
    end if;
    if new.vouchee = new.voucher then
      raise exception 'You cannot vouch for yourself.'
        using errcode = '42501';
    end if;
    new.revoked_at := null;
    return new;
  end if;

  if old.voucher is distinct from me and not coalesce(caller_is_root, false) then
    raise exception 'Only the voucher, or a root organiser, can revoke a vouch.'
      using errcode = '42501';
  end if;

  new.id := old.id;
  new.voucher := old.voucher;
  new.vouchee := old.vouchee;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists vouches_enforce_write on public.vouches;
create trigger vouches_enforce_write
  before insert or update on public.vouches
  for each row
  execute function public.enforce_vouch_write();

create or replace function public.enforce_venue_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  me uuid;
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if not public.is_vouched(auth.uid()) then
    raise exception 'Only vouched organisers can post. Ask an organiser to vouch for you.'
      using errcode = '42501';
  end if;

  select c.id into me
  from public.caller_organiser() c;

  if tg_op = 'INSERT' and new.created_by is null then
    new.created_by := me;
  end if;

  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.seed_key := old.seed_key;
  end if;

  return new;
end;
$$;

drop trigger if exists venues_enforce_write on public.venues;
create trigger venues_enforce_write
  before insert or update on public.venues
  for each row
  execute function public.enforce_venue_write();

create or replace function public.venue_contact(venue_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_vouched(auth.uid()) then
    raise exception 'Only vouched organisers can see venue contacts. Ask an organiser to vouch for you.'
      using errcode = '42501';
  end if;

  return (
    select v.contact
    from public.venues v
    where v.id = venue_id
  );
end;
$$;

revoke all on function public.venue_contact(uuid) from public;
grant execute on function public.venue_contact(uuid) to authenticated, service_role, postgres;

alter table public.root_emails enable row level security;
alter table public.organisers enable row level security;
alter table public.vouches enable row level security;
alter table public.communities enable row level security;
alter table public.venues enable row level security;
alter table public.hosted_events enable row level security;

drop policy if exists root_emails_none on public.root_emails;
create policy root_emails_none on public.root_emails
  for select
  using (false);

drop policy if exists organisers_select on public.organisers;
create policy organisers_select on public.organisers
  for select
  using (true);

drop policy if exists organisers_insert on public.organisers;
create policy organisers_insert on public.organisers
  for insert
  with check (auth.uid() is not null and auth_user_id = auth.uid() and is_root = false);

drop policy if exists vouches_select on public.vouches;
create policy vouches_select on public.vouches
  for select
  using (true);

drop policy if exists vouches_insert on public.vouches;
create policy vouches_insert on public.vouches
  for insert
  with check (public.is_vouched(auth.uid()));

-- USING (true) so the write trigger runs and raises a readable error.
-- A policy that filters the caller out would update zero rows and look like success.
drop policy if exists vouches_update on public.vouches;
create policy vouches_update on public.vouches
  for update
  using (true)
  with check (public.is_vouched(auth.uid()));

-- Verified venues stay visible. Pending venues stay visible only while their
-- creator is still vouched. A revoke hides that creator's pending rows at once.
-- Vouched callers can see every row, including hidden pending ones.
drop policy if exists venues_select on public.venues;
create policy venues_select on public.venues
  for select
  using (
    status = 'verified'
    or public.is_vouched(auth.uid())
    or (status = 'pending' and public.is_vouched(created_by))
  );

drop policy if exists venues_insert on public.venues;
create policy venues_insert on public.venues
  for insert
  with check (public.is_vouched(auth.uid()));

drop policy if exists venues_update on public.venues;
create policy venues_update on public.venues
  for update
  using (true)
  with check (public.is_vouched(auth.uid()));

drop policy if exists venues_delete on public.venues;
create policy venues_delete on public.venues
  for delete
  using (public.is_vouched(auth.uid()));

drop policy if exists communities_select on public.communities;
create policy communities_select on public.communities
  for select
  using (true);

drop policy if exists communities_insert on public.communities;
create policy communities_insert on public.communities
  for insert
  with check (public.is_vouched(auth.uid()));

drop policy if exists communities_update on public.communities;
create policy communities_update on public.communities
  for update
  using (public.is_vouched(auth.uid()))
  with check (public.is_vouched(auth.uid()));

drop policy if exists hosted_events_select on public.hosted_events;
create policy hosted_events_select on public.hosted_events
  for select
  using (true);

drop policy if exists hosted_events_insert on public.hosted_events;
create policy hosted_events_insert on public.hosted_events
  for insert
  with check (public.is_vouched(auth.uid()));

drop policy if exists hosted_events_update on public.hosted_events;
create policy hosted_events_update on public.hosted_events
  for update
  using (public.is_vouched(auth.uid()))
  with check (public.is_vouched(auth.uid()));

-- security_invoker so the venues select policy applies. contact is not in the list.
drop view if exists public.venues_public;
create view public.venues_public
with (security_invoker = true, security_barrier = true) as
select
  id,
  name,
  address,
  lat,
  lng,
  capacity,
  guest_count_lower_bound,
  has_av,
  av_notes,
  hours,
  evening_hours,
  weekend_hours,
  terms,
  notes,
  status,
  created_by,
  source,
  seed_key,
  venue_type,
  good_for,
  source_url,
  created_at,
  updated_at
from public.venues;

comment on view public.venues_public is
  'Venue rows safe for the map and for anon. Omits contact. Pending rows from a revoked organiser are hidden.';

-- Owner rights, so contact is readable, but only when the caller is vouched.
-- Unvouched callers get zero rows.
drop view if exists public.venues_organiser;
create view public.venues_organiser
with (security_barrier = true) as
select
  v.id,
  v.name,
  v.address,
  v.lat,
  v.lng,
  v.capacity,
  v.guest_count_lower_bound,
  v.has_av,
  v.av_notes,
  v.hours,
  v.evening_hours,
  v.weekend_hours,
  v.terms,
  v.contact,
  v.notes,
  v.status,
  v.created_by,
  v.source,
  v.seed_key,
  v.created_at,
  v.updated_at
from public.venues v
where public.is_vouched(auth.uid());

comment on view public.venues_organiser is
  'Full venue rows including contact. Empty unless is_vouched(auth.uid()) is true.';

revoke all on table public.root_emails from public, anon, authenticated;
revoke all on table public.organisers from public, anon, authenticated;
revoke all on table public.vouches from public, anon, authenticated;
revoke all on table public.communities from public, anon, authenticated;
revoke all on table public.venues from public, anon, authenticated;
revoke all on table public.hosted_events from public, anon, authenticated;
revoke all on table public.venues_public from public, anon, authenticated;
revoke all on table public.venues_organiser from public, anon, authenticated;

grant select (id, display_name, is_root, created_at)
  on public.organisers to anon, authenticated;
grant select (auth_user_id) on public.organisers to authenticated;

grant select on public.vouches to anon, authenticated;
grant insert (voucher, vouchee) on public.vouches to authenticated;
grant update (revoked_at) on public.vouches to authenticated;

grant select on public.communities to anon, authenticated;
grant insert on public.communities to authenticated;
grant update on public.communities to authenticated;

-- contact is deliberately absent. Insert still accepts contact.
-- A returning insert should list columns, or read venues_public afterwards.
grant select (
  id,
  name,
  address,
  lat,
  lng,
  capacity,
  guest_count_lower_bound,
  has_av,
  av_notes,
  hours,
  evening_hours,
  weekend_hours,
  terms,
  notes,
  status,
  created_by,
  source,
  seed_key,
  venue_type,
  good_for,
  source_url,
  created_at,
  updated_at
) on public.venues to anon, authenticated;

grant insert on public.venues to authenticated;
grant update on public.venues to authenticated;
grant delete on public.venues to authenticated;

grant select on public.hosted_events to anon, authenticated;
grant insert on public.hosted_events to authenticated;
grant update on public.hosted_events to authenticated;

grant select on public.venues_public to anon, authenticated;

-- Recurring sessions are public listings. Only the service role writes them.
alter table public.recurring_sessions enable row level security;
drop policy if exists recurring_sessions_select on public.recurring_sessions;
create policy recurring_sessions_select on public.recurring_sessions
  for select
  using (true);
grant select on public.recurring_sessions to anon, authenticated;
grant select on public.venues_organiser to authenticated;

grant insert (id, auth_user_id, email, display_name)
  on public.organisers to authenticated;
