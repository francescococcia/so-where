# Lumap seed: Luma London snapshot

- Source: Luma London discover feed (public, no key, undocumented): https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=discplace-QCcNk3HXowOR97j . Fetched 2026-10-22, 2 pages, 58 upcoming events (22 Oct to 26 Nov 2026; one past event removed from the snapshot).
- `luma-london.json`: all in-person events (name, dates, url, guest_count, calendar, address, lat/lng). `address_hidden: true` means Luma hides the address until RSVP and the coordinates are fuzzed.
- `venues-candidates.json`: candidate venues grouped by coordinates (4 dp), sorted by events_count. Status is `pending`: they are not verified. `max_guest_count_lower_bound` is the largest RSVP count seen, a lower bound and not a capacity. There are no claims about AV, terms or availability. Events with hidden addresses are excluded.
- `hosted_events.json`: who hosted where (venue_key, community = Luma calendar name, event, date, guest_count). This is the "past hosts" memory.
- "Personal" as a community means the event was posted from a host's personal Luma calendar, not a community calendar.
- This is a frozen snapshot, so the demo never depends on the live endpoint. Re-fetch politely (max 1 request every 2 s).
- No personal contact info is included: no host names, emails, LinkedIn/X/Instagram handles. Venue business addresses only.

## Events feed: `events-all.json`

Fetched 2026-10-22 ~19:50 BST, politely (1 request every 2+ s, browser User-Agent, 1 page per source). Raw responses are in `../raw/` (`devpost-upcoming-p1.json`, `devpost-open-p1.json`, `builderbase.json`, `mlh.html`, `meetup.html`). Rebuild offline with `python3 scripts/build_events.py` (no network).

| Source | URL | Kept |
|---|---|---|
| Luma (existing `luma-london.json`) | Luma London discover feed | 58 in person, London |
| Devpost | `https://devpost.com/api/hackathons?status[]=upcoming&search=london` (+ `status[]=open`) | 1 (2 returned; Hack Western 13 is London, Ontario, dropped; open = 0) |
| BuilderBase | `https://edge.builderbase.com/super-events/public/discovery?status=active&limit=100` | UK (country GB/United Kingdom) or online, of 29 |
| MLH | `https://mlh.io/seasons/2027/events` (`<script data-page="app">` JSON, `props.upcomingEvents`) | GB or online, of 69 worldwide |
| Meetup | `https://www.meetup.com/find/?location=gb--17--London&source=EVENTS&keywords=tech` (`__NEXT_DATA__` → `__APOLLO_STATE__` `Event:*`) | page 1 only |

Shape: `{fetched_at, ranking, sources:{name:{url,count,status,note,kept_after_dedup}}, events:[{id, source, title, url, start_at, end_at, city, lat, lng, format, size, size_kind, organiser, themes[], is_hackathon, score, reasons[], also_on?, city_note?}]}`.

- `size` is Luma "going", Devpost "registered", BuilderBase "participants" or Meetup "RSVPs". MLH has no size. BuilderBase 0 counts are stored as null.
- `organiser` is an organisation, community, calendar or Meetup group name only. Luma "Personal" = posted from a personal calendar; no names are stored.
- Meetup listings carry no venue, so `city: "London"` comes from the London search area (`city_note`); online Meetup events have `city: null`. Meetup has no end time; for dropping finished events only, a 3 h duration is assumed.
- Devpost dates come from `submission_period_dates` (day precision, midnight London). The Goldsmiths hackathon's city is inferred from the organiser name (`city_note`).
- Dedup key: normalised title + start date (London). No cross-source duplicates were found in this snapshot.
- Ranking (transparent, every point has a reason): `log10(size+1)` + 2 if in person/hybrid in London (0.5 if online) + `2*(1-days/42)` if starting within 6 weeks (2 if already under way) + 1.5 if hackathon. Sorted by score.
- No personal contact info: no host names, emails or social handles.
