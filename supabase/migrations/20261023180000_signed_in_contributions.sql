-- Contributions need a signed-in account; browsing stays open.
-- submissions.submitter and submission_vouches.voter become auth.users ids (auth.uid()),
-- replacing the random per-browser ids. Both tables were empty when this ran.

-- 1. Columns -----------------------------------------------------------------
alter table public.submissions
  drop column submitted_by,
  add column submitter uuid not null default auth.uid() references auth.users (id) on delete cascade;
create index submissions_submitter_created on public.submissions (submitter, created_at desc);

alter table public.submission_vouches
  drop column voter,
  add column voter uuid not null default auth.uid() references auth.users (id) on delete cascade;
alter table public.submission_vouches
  add constraint submission_vouches_one_per_voter unique (submission_id, voter);
create index submission_vouches_voter on public.submission_vouches (voter);

-- 2. Privileges: anon reads only; signed-in users add their own rows and may revoke their own vote.
revoke all on public.submissions, public.submission_vouches from anon, authenticated;
grant select on public.submissions, public.submission_vouches to anon, authenticated;
grant insert (kind, name, organiser, venue_name, address, area, capacity, day_of_week, start_time, end_time, price, url, note, lat, lng)
  on public.submissions to authenticated;
grant insert (submission_id, vote) on public.submission_vouches to authenticated;
grant delete on public.submission_vouches to authenticated;

drop policy "Anyone can submit a pending venue or session" on public.submissions;
drop policy "Anyone can vote once on a pending submission" on public.submission_vouches;

create policy "Signed-in users submit their own pending items" on public.submissions
  for insert to authenticated
  with check (
    submitter = (select auth.uid())
    and status = 'pending' and vouch_count = 0 and reject_count = 0 and decided_at is null
  );

create policy "Signed-in users vote once on someone else's pending item" on public.submission_vouches
  for insert to authenticated
  with check (
    voter = (select auth.uid())
    and exists (
      select 1 from public.submissions s
      where s.id = submission_id and s.status = 'pending' and s.submitter <> (select auth.uid())
    )
  );

create policy "Signed-in users revoke their own vote" on public.submission_vouches
  for delete to authenticated
  using (voter = (select auth.uid()));

-- 3. Guards ------------------------------------------------------------------
-- At most 5 submissions per user per 24 hours; submitter is always the caller.
create or replace function private.guard_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  recent integer;
begin
  if me is null then
    if current_user in ('postgres', 'supabase_admin', 'service_role') then
      return new;
    end if;
    raise exception 'Sign in to contribute' using errcode = 'insufficient_privilege';
  end if;
  new.submitter := me;
  select count(*) into recent
    from public.submissions
   where submitter = me and created_at > now() - interval '24 hours';
  if recent >= 5 then
    raise exception 'You can add up to 5 venues or sessions a day. Try again tomorrow.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Votes: only on pending items, never on your own, at most 50 a day.
create or replace function private.check_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.submissions%rowtype;
  me uuid := coalesce(auth.uid(), new.voter);
  recent integer;
begin
  new.voter := me;
  select * into s from public.submissions where id = new.submission_id for update;
  if not found or s.status <> 'pending' then
    raise exception 'This submission has already been decided' using errcode = 'check_violation';
  end if;
  if s.submitter = me then
    raise exception 'You cannot vouch for your own submission' using errcode = 'check_violation';
  end if;
  select count(*) into recent
    from public.submission_vouches
   where voter = me and created_at > now() - interval '24 hours';
  if recent >= 50 then
    raise exception 'That''s a lot of votes for one day. Try again tomorrow.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Re-count after every new or revoked vote: 2 distinct vouches = verified, 2 rejections = rejected,
-- otherwise pending. Revoking a vouch on a verified item drops it back to pending.
create or replace function private.tally_votes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sid uuid := coalesce(new.submission_id, old.submission_id);
  vouches integer;
  rejects integer;
begin
  select count(distinct voter) filter (where vote = 'vouch'),
         count(distinct voter) filter (where vote = 'reject')
    into vouches, rejects
    from public.submission_vouches
   where submission_id = sid;

  update public.submissions
     set vouch_count = vouches,
         reject_count = rejects,
         status = case when vouches >= 2 then 'verified' when rejects >= 2 then 'rejected' else 'pending' end,
         decided_at = case when vouches >= 2 or rejects >= 2 then coalesce(decided_at, now()) else null end
   where id = sid;
  return null;
end;
$$;

revoke all on function private.guard_submission() from public, anon, authenticated;
revoke all on function private.check_vote() from public, anon, authenticated;
revoke all on function private.tally_votes() from public, anon, authenticated;

create trigger submissions_guard before insert on public.submissions
  for each row execute function private.guard_submission();

drop trigger submission_vouches_tally on public.submission_vouches;
create trigger submission_vouches_tally after insert or delete on public.submission_vouches
  for each row execute function private.tally_votes();
