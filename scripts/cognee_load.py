#!/usr/bin/env python3
"""Re-runnable loader: seed/*.json -> fact docs -> Cognee Cloud dataset -> cognify.

Env (key is read ONLY from env, never printed or written):
  COGNEE_API_KEY, COGNEE_TENANT_ID, COGNEE_BASE_URL
Usage:
  python3 scripts/cognee_load.py            # generate docs, add, cognify, poll
  python3 scripts/cognee_load.py --docs-only
  python3 scripts/cognee_load.py --facts-only   # upload only sessions and venue facts
Re-running adds the docs again (Cognee dedups identical content by hash).
"""
import json, os, sys, time, glob, datetime as dt
import urllib.request, urllib.error, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, "seed")
DATA = os.path.join(ROOT, "src", "data")
DOCS = os.path.join(ROOT, "cognee", "docs")
DATASET = os.environ.get("COGNEE_DATASET", "lumap_london")
BATCH = 20


def community_label(c):
    return "a personal host calendar" if (c or "").strip().lower() == "personal" else (c or "an unnamed calendar")


def day(iso):
    return iso[:10] if iso else "unknown date"


def going(n):
    return f"{n} going" if n else "attendance not published"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


DAY_NAME = {"mon": "Monday", "tue": "Tuesday", "wed": "Wednesday", "thu": "Thursday",
            "fri": "Friday", "sat": "Saturday", "sun": "Sunday"}
USE_CASE = {"cowork": "coworking", "meetup": "a community meetup", "workshop": "a workshop", "party": "a private party"}
GOOD_FOR = {"coworking": "coworking", "community_event": "community events", "private_party": "private parties and birthdays",
            "workshop": "workshops"}


def slug(text):
    return "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-")[:50]


def fact_docs():
    """Public venue facts and recurring sessions from src/data."""
    facts = load(os.path.join(DATA, "venue-facts.json"))
    sessions = load(os.path.join(DATA, "recurring-sessions.json"))
    addr = {v["name"]: v["address"] for v in load(os.path.join(SEED, "venues-candidates.json"))["venues"]}
    addr.update({v["name"]: v["address"] for v in facts["new_venues"]})
    docs = {}
    for f in facts["venues"]:
        name = f["match"]
        parts = [f"Venue facts: {name}" + (f", {addr[name]}" if name in addr else "") + "."]
        parts.append(f"Type: {f['venue_type'].replace('_', ' ')}.")
        if f.get("good_for"):
            parts.append("Good for " + ", ".join(GOOD_FOR[g] for g in f["good_for"]) + ".")
        if f.get("capacity"):
            parts.append(f"Capacity up to {f['capacity']}" + (f" ({f['capacity_note']})." if f.get("capacity_note") else "."))
        if f.get("hours"):
            parts.append("Opening hours: " + ", ".join(f"{DAY_NAME[d]} {a}-{b}" for d, (a, b) in f["hours"].items()) + ".")
        else:
            parts.append("Opening hours not published.")
        if f.get("hours_note"):
            parts.append(f["hours_note"] + ".")
        if f.get("sources"):
            parts.append("Source: " + " ".join(f["sources"]))
        if len(parts) > 3 or f.get("sources"):
            docs[f"venuefacts-{slug(name)}.txt"] = " ".join(parts)
    for x in sessions["sessions"]:
        where = x["venue_name"] + (f", {addr[x['venue_name']]}" if x["venue_name"] in addr else "")
        doc = (f"Recurring session: '{x['title']}' by {x['organiser']} at {where}. "
               f"Good for {USE_CASE[x['use_case']]}. Every {DAY_NAME[x['day_of_week']]} {x['start_time']}-{x['end_time']} "
               f"({x['cadence']}). Price: {x['price'] or 'not stated'}. {x['rsvp'] or ''}. {x['summary']} "
               f"Link: {x['url']}. Checked {sessions['checked_on']}.")
        docs[f"session-{x['key']}.txt"] = doc
    return docs


def build_docs():
    venues = load(os.path.join(SEED, "venues-candidates.json"))["venues"]
    hosted = load(os.path.join(SEED, "hosted_events.json"))
    events = load(os.path.join(SEED, "events-all.json"))["events"]
    by_venue = {}
    for h in hosted:
        by_venue.setdefault(h["venue_key"], []).append(h)
    docs = {}

    for v in venues:
        hs = sorted(by_venue.get(v["key"], []), key=lambda h: h["date"])
        lines = [f"Venue: {v['name']}, {v['address']} (lat {v['lat']:.5f}, lng {v['lng']:.5f})."]
        for h in hs:
            lines.append(f"Hosted {community_label(h['community'])} event '{h['event_name']}' on {day(h['date'])} with {going(h['guest_count'])}.")
        lines.append(f"This is a candidate venue from Luma, not verified (status {v['status']}); " +
                     (f"capacity is at least {v['max_guest_count_lower_bound']} based on the largest event seen there. "
                      if v['max_guest_count_lower_bound'] else "capacity is unknown (no attendance published). ") +
                     "No AV, pricing or availability information is known.")
        docs[f"venue-{v['key'].replace(',', '_')}.txt"] = " ".join(lines)

    names = {v["key"]: v["name"] for v in venues}
    by_comm = {}
    for h in hosted:
        if (h["community"] or "").lower() == "personal":
            continue  # personal calendars are not communities
        by_comm.setdefault(h["community"], []).append(h)
    for c, hs in sorted(by_comm.items()):
        parts = [f"{names.get(h['venue_key'], h['venue_name'])} ('{h['event_name']}', {day(h['date'])}, {going(h['guest_count'])})" for h in hs]
        doc = (f"Community: {c}, a London community calendar on Luma. It has hosted events at these venues: "
               + "; ".join(parts) + f". Largest event size: {going(max(h['guest_count'] for h in hs))}.")
        slug = "".join(ch if ch.isalnum() else "-" for ch in c.lower()).strip("-")[:50]
        docs[f"community-{slug}.txt"] = doc

    now = dt.datetime.now(dt.timezone.utc)
    ranked = sorted([e for e in events if e.get("start_at") and dt.datetime.fromisoformat(e["start_at"].replace("Z", "+00:00")) > now],
                    key=lambda e: -e["score"])
    for i, e in enumerate(ranked, 1):
        org = community_label(e.get("organiser")) if e.get("organiser") else "an unknown organiser"
        size = f"{e['size']} {e['size_kind']}" if e.get("size") else "size unknown"
        doc = (f"Upcoming event (rank {i} of {len(ranked)}, score {e['score']}): '{e['title']}' by {org}, "
               f"source {e['source']}, starts {day(e['start_at'])}, {e.get('format') or 'format unknown'}, "
               f"city {e.get('city') or 'unknown'}, {size}{', hackathon' if e.get('is_hackathon') else ''}. "
               f"Ranked because: {', '.join(e.get('reasons') or [])}. Link: {e.get('url')}")
        docs[f"event-{i:03d}.txt"] = doc
    docs.update(fact_docs())
    return docs


def write_docs(docs):
    os.makedirs(DOCS, exist_ok=True)
    for f in glob.glob(os.path.join(DOCS, "*.txt")):
        os.remove(f)
    for name, text in docs.items():
        with open(os.path.join(DOCS, name), "w", encoding="utf-8") as f:
            f.write(text + "\n")


def _env():
    try:
        return os.environ["COGNEE_BASE_URL"].rstrip("/"), os.environ["COGNEE_API_KEY"], os.environ["COGNEE_TENANT_ID"]
    except KeyError as k:
        sys.exit(f"missing env var {k}")


def call(method, path, body=None, content_type=None, timeout=120):
    base, key, tenant = _env()
    req = urllib.request.Request(base + "/api/v1" + path, data=body, method=method,
                                 headers={"X-Api-Key": key, "X-Tenant-Id": tenant,
                                          **({"Content-Type": content_type} if content_type else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:500]


def add_batch(items):
    # This tenant's /add only ingests the `data` file field (raw_data strings are
    # accepted with HTTP 200 but ingest nothing), so each doc goes up as a .txt file.
    b = uuid.uuid4().hex
    parts = [f'--{b}\r\nContent-Disposition: form-data; name="datasetName"\r\n\r\n{DATASET}\r\n']
    for name, t in items:
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="data"; filename="{name}"\r\n'
                     f'Content-Type: text/plain\r\n\r\n{t}\r\n')
    body = ("".join(parts) + f"--{b}--\r\n").encode()
    return call("POST", "/add", body, f"multipart/form-data; boundary={b}", timeout=180)


def main():
    docs = build_docs()
    write_docs(docs)
    kinds = {}
    for n in docs:
        kinds[n.split("-")[0]] = kinds.get(n.split("-")[0], 0) + 1
    print(f"wrote {len(docs)} docs to {DOCS}: {kinds}")
    if "--docs-only" in sys.argv:
        return
    items = list(docs.items())
    if "--facts-only" in sys.argv:
        items = [(n, t) for n, t in items if n.startswith(("session-", "venuefacts-"))]
        print(f"uploading only the {len(items)} session and venue-fact docs")
    for i in range(0, len(items), BATCH):
        st, res = add_batch(items[i:i + BATCH])
        n = len(res.get("data_ingestion_info") or []) if isinstance(res, dict) else 0
        print(f"add batch {i // BATCH + 1}: HTTP {st}, {n} items ingested", "" if st == 200 else res)
        if st != 200:
            sys.exit(1)
    t0 = time.time()
    st, res = call("POST", "/cognify", json.dumps({"datasets": [DATASET], "runInBackground": True}).encode(), "application/json")
    print(f"cognify: HTTP {st} {json.dumps(res)[:400]}")
    st, ds = call("GET", "/datasets/")
    ds_id = next((d["id"] for d in (ds if isinstance(ds, list) else []) if d.get("name") == DATASET), None)
    print("dataset id:", ds_id)
    while ds_id and time.time() - t0 < 900:
        time.sleep(5)
        st, s = call("GET", f"/datasets/status?dataset={ds_id}")
        status = s.get(ds_id) if isinstance(s, dict) else s
        print(f"[{time.time() - t0:5.0f}s] status: {status}")
        if isinstance(status, str) and ("COMPLETED" in status or "ERRORED" in status):
            break


if __name__ == "__main__":
    main()
