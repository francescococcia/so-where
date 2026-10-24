// Where distances are measured from, and walking-time estimates.

export type Origin = { kind: "area" | "me" | "postcode" | "map"; lat: number; lng: number; label: string };

export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const WALK_M_PER_MIN = 80;

export function distanceText(m: number) {
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function walkText(m: number) {
  const min = Math.max(1, Math.round(m / WALK_M_PER_MIN));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min walk` : `${min} min walk`;
}

/** "1.2 km from Old Street · 15 min walk" */
export function fromText(m: number, origin: Origin) {
  const where = origin.kind === "area" ? origin.label : origin.kind === "me" ? "you" : origin.label;
  return `${distanceText(m)} from ${where} · ${walkText(m)}`;
}

export const IN_LONDON = (p: { lat: number; lng: number }) => p.lat > 51.28 && p.lat < 51.7 && p.lng > -0.52 && p.lng < 0.34;

export async function lookupPostcode(raw: string): Promise<Origin | { error: string }> {
  const pc = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(pc) && !/^[A-Z]{1,2}\d[A-Z\d]?$/.test(pc)) return { error: "That doesn't look like a UK postcode." };
  try {
    const full = pc.length > 4;
    const r = await fetch(full ? `https://api.postcodes.io/postcodes/${pc}` : `https://api.postcodes.io/outcodes/${pc}`);
    const j = (await r.json()) as { result?: { latitude: number; longitude: number; postcode?: string; outcode?: string } };
    if (!j.result) return { error: "Couldn't find that postcode." };
    return { kind: "postcode", lat: j.result.latitude, lng: j.result.longitude, label: j.result.postcode ?? j.result.outcode ?? pc };
  } catch {
    return { error: "Couldn't look up that postcode right now." };
  }
}
