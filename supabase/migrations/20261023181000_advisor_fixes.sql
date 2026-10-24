-- Security advisor fixes (lints 0010, 0028, 0029) without changing behaviour.
-- The SECURITY DEFINER bodies move to the unexposed `private` schema; the public names stay as
-- thin SECURITY INVOKER wrappers so existing policies, triggers and search_venues keep working.
-- search_venues stays SECURITY DEFINER and callable by anon on purpose: it is the public search API.

grant usage on schema private to anon, authenticated;

-- is_vouched: used by RLS on venues (also evaluated for anon via venues_public).
create or replace function private.is_vouched(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive reached as (
    select o.id from public.organisers o where o.is_root
    union
    select v.vouchee from public.vouches v join reached r on r.id = v.voucher where v.revoked_at is null
  )
  select coalesce(
    (select true from public.organisers o join reached r on r.id = o.id
      where uid is not null and (o.id = uid or o.auth_user_id = uid) limit 1),
    false);
$$;
revoke all on function private.is_vouched(uuid) from public;
grant execute on function private.is_vouched(uuid) to anon, authenticated;

create or replace function public.is_vouched(uid uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.is_vouched(uid) $$;

-- caller_organiser: used by the venue/vouch write triggers (signed-in callers only).
create or replace function private.caller_organiser()
returns table (id uuid, is_root boolean)
language sql
stable
security definer
set search_path = ''
as $$ select o.id, o.is_root from public.organisers o where o.auth_user_id = auth.uid() $$;
revoke all on function private.caller_organiser() from public;
grant execute on function private.caller_organiser() to authenticated;

create or replace function public.caller_organiser()
returns table (id uuid, is_root boolean)
language sql
stable
security invoker
set search_path = ''
as $$ select c.id, c.is_root from private.caller_organiser() c $$;
revoke execute on function public.caller_organiser() from public, anon;
grant execute on function public.caller_organiser() to authenticated;

-- email_is_root: only the organiser-insert trigger needs it; nobody may probe root emails over the API.
create or replace function private.email_is_root(address text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select exists (select 1 from public.root_emails r where address is not null and lower(r.email) = lower(address)) $$;
revoke all on function private.email_is_root(text) from public;
grant execute on function private.email_is_root(text) to authenticated;
revoke execute on function public.email_is_root(text) from public, anon, authenticated;

create or replace function public.protect_organiser_flags()
returns trigger
language plpgsql
set search_path = 'public'
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
    if private.email_is_root(new.email) then
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

-- venue_contact: vouched organisers only (checked inside), never anon.
create or replace function private.venue_contact(venue_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_vouched(auth.uid()) then
    raise exception 'Only vouched organisers can see venue contacts. Ask an organiser to vouch for you.'
      using errcode = '42501';
  end if;
  return (select v.contact from public.venues v where v.id = venue_id);
end;
$$;
revoke all on function private.venue_contact(uuid) from public;
grant execute on function private.venue_contact(uuid) to authenticated;

create or replace function public.venue_contact(venue_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$ select private.venue_contact(venue_id) $$;
revoke execute on function public.venue_contact(uuid) from public, anon;
grant execute on function public.venue_contact(uuid) to authenticated;

-- handle_new_user runs only as the auth.users trigger; nobody calls it over the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- venues_organiser: same rows and columns, but RLS of the caller now applies (security_invoker);
-- the contact column comes through venue_contact(), which re-checks the vouch.
create or replace view public.venues_organiser
with (security_invoker = true, security_barrier = true)
as
select v.id, v.name, v.address, v.lat, v.lng, v.capacity, v.guest_count_lower_bound, v.has_av, v.av_notes,
       v.hours, v.evening_hours, v.weekend_hours, v.terms, public.venue_contact(v.id) as contact, v.notes,
       v.status, v.created_by, v.source, v.seed_key, v.created_at, v.updated_at
  from public.venues v
 where public.is_vouched(auth.uid());
revoke all on public.venues_organiser from anon;
grant select on public.venues_organiser to authenticated;
