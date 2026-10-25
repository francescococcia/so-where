# Expands src/data/osm-snapshot.json with REAL OpenStreetMap cafés, pubs, bars and restaurants around outer
# London hubs (Greenwich, Stratford, Canary Wharf, …), so the plan's fallback and the Atlas seed cover them.
# Source: the Geofabrik Greater London extract (OSM data, © OpenStreetMap contributors, ODbL), used because
# public Overpass is often unreachable. Existing snapshot elements are kept; new ones are added by OSM id.
# Run:  curl -L -o /tmp/london.osm.pbf https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf
#       python3 -m venv /tmp/osmv && /tmp/osmv/bin/pip install osmium
#       /tmp/osmv/bin/python scripts/build_osm_hub_snapshot.py /tmp/london.osm.pbf
# Then load into Atlas:  npm run seed:mongo
import json, math, re, sys
from datetime import datetime, timezone
import osmium

PBF = sys.argv[1] if len(sys.argv) > 1 else "/tmp/london.osm.pbf"
RADIUS_M = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
HUBS = {
    "Greenwich": (51.4810, -0.0065), "Stratford": (51.5416, -0.0033), "Canary Wharf": (51.5035, -0.0187),
    "Brixton": (51.4627, -0.1145), "Clapham": (51.4618, -0.1384), "Hammersmith": (51.4927, -0.2240),
    "Camden": (51.5392, -0.1426), "Islington": (51.5362, -0.1033), "Hackney": (51.5450, -0.0553),
    "Shoreditch": (51.5265, -0.0784), "Walthamstow": (51.5830, -0.0199), "Lewisham": (51.4657, -0.0142),
    "Richmond": (51.4633, -0.3013), "Wimbledon": (51.4214, -0.2064), "Kilburn": (51.5470, -0.1910),
    "Finsbury Park": (51.5642, -0.1065),
}
AMENITY = re.compile(r"^(pub|bar|biergarten|cafe|restaurant)$")
KEEP = re.compile(r"^(name|amenity|tourism|shop|opening_hours|check_date.*|survey:date|addr:.*|fee|website|contact:website|wheelchair|cuisine|description|outdoor_seating|indoor_seating|beer_garden|garden:type|covered)$")

def dist(a, b):
    R = 6371000; p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))

def hub_of(lat, lng):
    for h, c in HUBS.items():
        if dist(c, (lat, lng)) <= RADIUS_M: return h
    return None

found = []
fp = osmium.FileProcessor(PBF).with_areas().with_filter(osmium.filter.KeyFilter("amenity"))
for o in fp:
    t = dict(o.tags)
    if not AMENITY.match(t.get("amenity", "")) or not t.get("name"): continue
    if o.is_node():
        typ, oid, lat, lng = "node", o.id, o.location.lat, o.location.lon
    elif o.is_area():
        try:
            ring = next(iter(o.outer_rings()))
            pts = [(n.lat, n.lon) for n in ring]
        except Exception:
            continue
        if not pts: continue
        lat, lng = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        typ, oid = ("way", o.orig_id()) if o.from_way() else ("relation", o.orig_id())
    else:
        continue
    h = hub_of(lat, lng)
    if not h: continue
    found.append((h, {"type": typ, "id": oid, "lat": round(lat, 7), "lng": round(lng, 7), "tags": {k: v for k, v in t.items() if KEEP.match(k)}}))

path = "src/data/osm-snapshot.json"
doc = json.load(open(path))
have = {(e["type"], e["id"]) for e in doc["elements"]}
added, per = 0, {}
for h, e in found:
    c = per.setdefault(h, {"all": 0, "hours": 0, "new": 0})
    c["all"] += 1; c["hours"] += 1 if e["tags"].get("opening_hours") else 0
    if (e["type"], e["id"]) in have: continue
    have.add((e["type"], e["id"])); doc["elements"].append(e); added += 1; c["new"] += 1
doc["hub_extract"] = {
    "source": "Geofabrik Greater London extract (OpenStreetMap, © OpenStreetMap contributors, ODbL)",
    "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "osm_base": osmium.io.Reader(PBF, osmium.osm.osm_entity_bits.NOTHING).header().get("osmosis_replication_timestamp") or None,
    "radius_m": RADIUS_M, "hubs": sorted(HUBS), "added": added,
}
open(path, "w").write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
for h in sorted(per): print(f"{h:14s} {per[h]['all']:5d} venues, {per[h]['hours']:5d} with hours, {per[h]['new']:5d} new")
print(f"added {added}; snapshot now {len(doc['elements'])} elements")
