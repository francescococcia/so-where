"""Build seed/events-all.json from raw snapshots (no network). Transparent ranking."""
import json, re, math
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
R = Path(__file__).resolve().parent.parent
RAW, SEED = R/'raw', R/'seed'
LON = ZoneInfo('Europe/London')
NOW = datetime.now(timezone.utc)

def iso(s):
    if not s: return None
    return datetime.fromisoformat(s.replace('Z', '+00:00'))

events, sources = [], {}

# Luma (existing snapshot)
l = json.load(open(SEED/'luma-london.json'))
for e in l['events']:
    g = e.get('geo_address_info') or {}
    events.append(dict(id='luma:'+e['api_id'], source='luma', title=e['name'].strip(), url=e['url'],
        start_at=e['start_at'], end_at=e.get('end_at'), city=g.get('city'), lat=g.get('lat'), lng=g.get('lng'),
        format={'offline':'in_person','online':'online'}.get(e.get('location_type'), 'in_person'),
        size=e.get('guest_count'), size_kind='going', organiser=(e.get('calendar') or {}).get('name'), themes=[]))
sources['luma'] = dict(url='https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=discplace-QCcNk3HXowOR97j',
                       count=len(l['events']), status='ok', note='existing snapshot luma-london.json (in-person only)')

# Devpost
MON = {m:i for i,m in enumerate(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],1)}
def dp_dates(s):
    m = re.match(r'(\w{3}) (\d{1,2}) - (?:(\w{3}) )?(\d{1,2}), (\d{4})', s or '')
    if not m: return None, None
    m1, d1, m2, d2, y = m.groups(); m2 = m2 or m1
    return (datetime(int(y), MON[m1], int(d1), tzinfo=LON).isoformat(), datetime(int(y), MON[m2], int(d2), tzinfo=LON).isoformat())
dp_kept = dp_total = 0
for f, st in [('devpost-upcoming-p1.json','upcoming'), ('devpost-open-p1.json','open')]:
    d = json.load(open(RAW/f))
    for h in d['hackathons']:
        dp_total += 1
        loc = (h.get('displayed_location') or {}).get('location') or ''
        org = h.get('organization_name') or ''
        if 'canada' in loc.lower(): continue   # London, Ontario: not our London
        if loc.lower() == 'online': city, fmt = None, 'online'
        elif 'london' in loc.lower(): city, fmt = 'London', 'in_person'
        elif 'london' in org.lower(): city, fmt = 'London', 'in_person'  # inferred from organiser name, see city_note
        else: city, fmt = None, 'in_person'
        s, en = dp_dates(h.get('submission_period_dates'))
        events.append(dict(id=f"devpost:{h['id']}", source='devpost', title=h['title'].strip(), url=h['url'], start_at=s, end_at=en,
            city=city, location_text=loc, lat=None, lng=None, format=fmt, size=h.get('registrations_count'), size_kind='registered',
            organiser=org or None, themes=[t['name'] for t in h.get('themes', [])], is_hackathon=True))
        if city == 'London' and 'london' not in loc.lower(): events[-1]['city_note'] = 'inferred from organiser name; listing location is: ' + loc
        dp_kept += 1
sources['devpost'] = dict(url='https://devpost.com/api/hackathons?status[]=upcoming|open&search=london', count=dp_kept,
    status='ok', note=f'{dp_total} returned (upcoming 2, open 0; 1 page each was enough); Hack Western 13 dropped (London, Ontario, Canada)')

# BuilderBase
b = json.load(open(RAW/'builderbase.json'))['data']['events']; bk = 0
for e in b:
    loc = e.get('location') or {}
    if (loc.get('country') or '') not in ('GB', 'United Kingdom') and e.get('format') != 'online': continue
    fmt = {'onsite':'in_person','online':'online','hybrid':'hybrid'}.get(e.get('format'), e.get('format'))
    events.append(dict(id='builderbase:'+e['id'], source='builderbase', title=e['name'].strip(),
        url=e.get('external_url') or f"https://builderbase.com/event/{e['slug']}", start_at=e.get('start_at'), end_at=e.get('end_at'),
        city=loc.get('city'), lat=loc.get('lat'), lng=loc.get('lng'), format=fmt, size=e.get('participant_count') or None, size_kind='participants',
        organiser=(e.get('organization') or {}).get('name'), themes=(e.get('theme_tags') or []) + ([e['event_type']] if e.get('event_type') else []),
        is_hackathon=e.get('event_type') == 'hackathon' or 'hack' in e['name'].lower())); bk += 1
sources['builderbase'] = dict(url='https://edge.builderbase.com/super-events/public/discovery?status=active&limit=100', count=bk, status='ok',
    note=f'{len(b)} returned, kept UK (country GB/United Kingdom) or online')

# MLH
h = open(RAW/'mlh.html').read()
u = json.loads(re.search(r'data-page="app" type="application/json">(.*?)</script>', h, re.S)[1])['props']['upcomingEvents']; mk = 0
for e in u:
    va = e.get('venueAddress') or {}
    fmt = {'physical':'in_person','digital':'online','hybrid_physical':'hybrid','hybrid':'hybrid'}.get(e.get('formatType'), e.get('formatType'))
    if va.get('country') != 'GB' and fmt != 'online': continue
    events.append(dict(id='mlh:'+e['id'], source='mlh', title=e['name'].strip(), url=e.get('websiteUrl') or 'https://mlh.io'+e['url'],
        start_at=e['startsAt'], end_at=e.get('endsAt'), city=va.get('city'), lat=None, lng=None, format=fmt, size=None, size_kind=None,
        organiser='MLH member event', themes=(e.get('customFields') or {}).get('hackathon_focus') or [], is_hackathon=True)); mk += 1
sources['mlh'] = dict(url='https://mlh.io/seasons/2027/events', count=mk, status='ok', note=f'{len(u)} upcoming worldwide, kept GB or online')

# Meetup
h = open(RAW/'meetup.html').read()
a = json.loads(re.search(r'__NEXT_DATA__[^>]*>(.*?)</script>', h, re.S)[1])['props']['pageProps']['__APOLLO_STATE__']; mt = 0
for k, e in a.items():
    if not k.startswith('Event:'): continue
    grp = a.get((e.get('group') or {}).get('__ref', ''), {})
    events.append(dict(id='meetup:'+e['id'], source='meetup', title=e['title'].strip(), url=e['eventUrl'], start_at=e['dateTime'],
        end_at=e.get('endTime'), city=None if e.get('eventType') == 'ONLINE' else 'London', city_note='from Meetup London search area, no venue in listing', lat=None, lng=None,
        format={'PHYSICAL':'in_person','ONLINE':'online','HYBRID':'hybrid'}.get(e.get('eventType'), (e.get('eventType') or '').lower()),
        size=(e.get('rsvps') or {}).get('totalCount'), size_kind='RSVPs', organiser=grp.get('name'), themes=['tech'])); mt += 1
sources['meetup'] = dict(url='https://www.meetup.com/find/?location=gb--17--London&source=EVENTS&keywords=tech', count=mt, status='ok', note='page 1 only (~25-28 events)')

# Drop events already finished
_before = {}
for e in events: _before[e['source']] = _before.get(e['source'], 0) + 1
_ended = [e for e in events if (iso(e['end_at']) or (iso(e['start_at']) + timedelta(hours=3) if e['start_at'] else NOW)) < NOW]  # no end time: assume 3 h, for filtering only
events = [e for e in events if e not in _ended]
for n in _before: sources[n]['dropped_finished'] = sum(1 for e in _ended if e['source'] == n)

# Dedup by normalised title + London start date
def norm(t): return re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9 ]", ' ', t.lower().replace("'", ''))).strip()
best = {}
for e in events:
    k = (norm(e['title']), iso(e['start_at']).astimezone(LON).date().isoformat() if e['start_at'] else None)
    if k in best:
        o = best[k]; keep, other = (e, o) if (e.get('size') or 0) > (o.get('size') or 0) else (o, e)
        keep.setdefault('also_on', []).append(other['source'])
        for f in ('lat','lng','city','end_at'):
            if keep.get(f) is None and other.get(f) is not None: keep[f] = other[f]
        keep['themes'] = sorted(set(keep['themes']) | set(other['themes'])); best[k] = keep
    else: best[k] = e
events = list(best.values())

# Ranking
for e in events:
    score, reasons = 0.0, []
    if e.get('size'):
        s = math.log10(e['size'] + 1); score += s; reasons.append(f"{e['size']} {e['size_kind']}")
    if e['format'] in ('in_person','hybrid') and (e.get('city') or '').lower() == 'london':
        score += 2; reasons.append(f"{'in person' if e['format']=='in_person' else 'hybrid'}, London")
    elif e['format'] == 'online': score += 0.5; reasons.append('online')
    elif e.get('city'): reasons.append(f"in person, {e['city']} (outside London)")
    st = iso(e['start_at'])
    if st:
        days = (st - NOW).total_seconds() / 86400
        if days < 0: score += 2; reasons.append('happening now')
        elif days <= 42:
            score += 2 * (1 - days / 42); n = (st.astimezone(LON).date() - NOW.astimezone(LON).date()).days
            reasons.append('today' if n == 0 else 'tomorrow' if n == 1 else f'in {n} days')
        else: reasons.append(f'in {int(days)} days (beyond 6 weeks)')
    hk = e.pop('is_hackathon', False) or 'hack' in e['title'].lower()
    if hk: score += 1.5; reasons.append('hackathon')
    e['is_hackathon'] = hk; e['score'] = round(score, 3); e['reasons'] = reasons
events.sort(key=lambda e: -e['score'])
for name, s in sources.items(): s['kept_after_dedup'] = sum(1 for e in events if e['source'] == name)
out = dict(fetched_at=NOW.isoformat(timespec='seconds'), ranking='score = log10(size+1) + 2 if in person/hybrid in London (0.5 if online) + 2*(1-days/42) if starting within 6 weeks (2 if under way) + 1.5 if hackathon',
           sources=sources, events=events)
json.dump(out, open(SEED/'events-all.json', 'w'), indent=1, ensure_ascii=False)
print(json.dumps(sources, indent=1)); print('total', len(events))
for e in events[:12]: print(e['score'], e['source'], e.get('also_on'), e['title'][:60], e['start_at'][:16], e['reasons'])
