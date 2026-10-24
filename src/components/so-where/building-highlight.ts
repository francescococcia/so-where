// Find the OSM building a venue sits in, from the vector tiles already loaded on the map.
// querySourceFeatures + our own point-in-polygon (no extra deps); nearest footprint within ~25 m as a fallback.
import type { Map as MLMap } from "maplibre-gl";

type Ring = [number, number][];
type Poly = Ring[];
export type Building = { feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>; id: string | number | undefined; height: number; base: number; inside: boolean; distM: number };

const M_PER_DEG = 111_320;

function polysOf(g: GeoJSON.Geometry): Poly[] {
  if (g.type === "Polygon") return [g.coordinates as Poly];
  if (g.type === "MultiPolygon") return g.coordinates as Poly[];
  return [];
}

/** Even-odd ray cast over all rings (outer + holes). */
function inRing(x: number, y: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPoly(x: number, y: number, poly: Poly) {
  if (!poly.length || !inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false;
  return true;
}

/** Distance in metres from a point to the polygon's edges (local equirectangular projection). */
function distM(lng: number, lat: number, poly: Poly) {
  const kx = Math.cos((lat * Math.PI) / 180) * M_PER_DEG;
  const ky = M_PER_DEG;
  let best = Infinity;
  for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = (ring[i][0] - lng) * kx, ay = (ring[i][1] - lat) * ky;
      const bx = (ring[i + 1][0] - lng) * kx, by = (ring[i + 1][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** Grow a footprint a hair around its centroid so the lit walls sit just outside the stone ones (no z-fighting). */
function grow(poly: Poly, f: number): Poly {
  const outer = poly[0];
  let cx = 0, cy = 0;
  for (const [x, y] of outer) { cx += x; cy += y; }
  cx /= outer.length; cy /= outer.length;
  return poly.map((r) => r.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f] as [number, number]));
}

type Box = [number, number, number, number];
function bbox(poly: Poly, pad: number): Box {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of poly[0] ?? []) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a - pad, b - pad, c + pad, d + pad];
}
const overlaps = (p: Box, q: Box) => p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];

export function findBuilding(map: MLMap, at: { lat: number; lng: number }, maxM = 25): Building | null {
  if (!map.getSource("omt")) return null;
  let feats: GeoJSON.Feature[] = [];
  try {
    feats = map.querySourceFeatures("omt", { sourceLayer: "building" }) as unknown as GeoJSON.Feature[];
  } catch {
    return null;
  }
  // Work per polygon part: low-zoom tiles merge whole blocks into one MultiPolygon, so never light a whole feature.
  let hit: { f: GeoJSON.Feature; poly: Poly; d: number; inside: boolean } | null = null;
  for (const f of feats) {
    if (!f.geometry) continue;
    for (const poly of polysOf(f.geometry)) {
      if (inPoly(at.lng, at.lat, poly)) {
        hit = { f, poly, d: 0, inside: true };
        break;
      }
      const d = distM(at.lng, at.lat, poly);
      if (d <= maxM && (!hit || (!hit.inside && d < hit.d))) hit = { f, poly, d, inside: false };
    }
    if (hit?.inside) break;
  }
  if (!hit) return null;
  const id = hit.f.id;
  // A building crossing a tile edge comes back in pieces that share an id: add same-id parts that touch the hit part.
  const box = bbox(hit.poly, 3e-5);
  const extra = id !== undefined && id !== null
    ? feats.filter((f) => f !== hit!.f && f.id === id).flatMap((f) => polysOf(f.geometry)).filter((p) => overlaps(box, bbox(p, 0)))
    : [];
  const polys = [hit.poly, ...extra].map((p) => grow(p, 1.015));
  const props = (hit.f.properties ?? {}) as Record<string, unknown>;
  const height = Number(props.render_height ?? props.height ?? 8) || 8;
  const base = Number(props.render_min_height ?? props.min_height ?? 0) || 0;
  return {
    feature: { type: "Feature", id: id ?? undefined, properties: { h: height, b: base }, geometry: { type: "MultiPolygon", coordinates: polys } },
    id: id ?? undefined,
    height,
    base,
    inside: hit.inside,
    distM: Math.round(hit.d),
  };
}
