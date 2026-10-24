-- Public-source facts often live on different pages of a venue's site
-- (hire page for price, access page for step-free). Allow one public_source
-- report per venue *page*, so each fact keeps the exact URL it came from.
drop index if exists public.venue_reports_one_public_source;
create unique index if not exists venue_reports_public_source_page
  on public.venue_reports (venue_id, source_url)
  where source = 'public_source';
