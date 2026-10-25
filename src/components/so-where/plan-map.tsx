"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng, Leg, PlanResultWithAgent } from "@/lib/plan-types";
import hubsDoc from "@/data/hubs.json";
import { SO_WHERE_STYLE } from "./map-style";
import { legStretches, segmentsOf, type MapStretch } from "./journey";
import { findBuilding } from "./building-highlight";
import { badge, buildTrack, clearActiveSeg, midpoints, sampleTrack, setActiveSeg, type Track, type Who } from "./vehicles";

/** Idle view: the South Bank, tilted, so the 3D city is the first thing you see. */
const LONDON: [number, number] = [-0.1135, 51.5065];
const HUBS = (hubsDoc as { hubs: { name: string; lat: number; lng: number }[] }).hubs;

export type MapPadding = { top: number; right: number; bottom: number; left: number };
/** ui24: places named in the ask (bundled station list, resolved in the browser) and their middle, for the loading radar. */
export type ScanFocus = { places: { name: string; at: LatLng }[]; middle: LatLng | null };

type Props = {
  result: PlanResultWithAgent | null;
  selectedId: string | null;
  hoverId: string | null;
  focusId: string | null;
  scanning: boolean;
  /** Where the radar looks while planning; null/empty = stay on the current view. */
  scanFocus?: ScanFocus | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  padding: MapPadding;
  reduced: boolean;
  /** The device position (already rounded to ~100 m) when "Use my location" is on: draws an honest ~100 m ring. */
  deviceYou?: LatLng | null;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ll = (p: LatLng): [number, number] => [p.lng, p.lat];
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const FC = (features: GeoJSON.Feature[] = []): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });

function circle(center: LatLng, radiusM: number, steps = 72): GeoJSON.Feature {
  const coords: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: { r: radiusM }, geometry: { type: "Polygon", coordinates: [coords] } };
}

const line = (coords: [number, number][]): GeoJSON.Feature => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
const EMPTY_LINE = line([]);

/** Draw the first `t` (0–1) of a person's journey, stretch by stretch, keeping each stretch's colour. */
function stretchFeatures(st: MapStretch[], t: number): GeoJSON.Feature[] {
  if (t <= 0) return [];
  const n = st.reduce((a, s) => a + s.coords.length - 1, 0) || 1;
  let budget = t * n;
  const out: GeoJSON.Feature[] = [];
  for (const s of st) {
    const segs = s.coords.length - 1;
    if (budget <= 0) break;
    const f = Math.min(1, budget / segs);
    budget -= segs;
    const c = f >= 1 ? s.coords : partial(s.coords, f);
    if (c.length >= 2) out.push({ type: "Feature", properties: { kind: s.kind, color: s.color, label: s.label }, geometry: { type: "LineString", coordinates: c } });
  }
  return out;
}

/** Part of a polyline, measured by length, for the draw-in. */
function partial(coords: [number, number][], t: number) {
  if (t >= 1 || coords.length < 2) return coords;
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = total * t;
  const out: [number, number][] = [coords[0]];
  for (let i = 0; i < seg.length; i++) {
    if (want >= seg[i]) {
      out.push(coords[i + 1]);
      want -= seg[i];
    } else {
      const f = seg[i] ? want / seg[i] : 0;
      out.push([coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f]);
      break;
    }
  }
  return out;
}

// Marching-ants frames for the route "flow" layer (classic maplibre dash-cycling).
const DASHES: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

const COLOR = { you: "#e8590c", them: "#1478a3" } as const; // you = orange, them = sky (red is reserved for buses/errors)
const ACCENT = "#ff6b2c";

function addLayers(map: MLMap) {
  const before = map.getLayer("water-name") ? "water-name" : undefined;
  // Selected venue: its building lit in orange (separate extrusion, lighter cap, soft ground glow), or a ground ring.
  const under = map.getLayer("building-3d") ? "building-3d" : before;
  map.addSource("lit-ring", { type: "geojson", data: FC() });
  map.addLayer({ id: "lit-ring-fill", type: "fill", source: "lit-ring", paint: { "fill-color": ACCENT, "fill-opacity": 0.16 } }, under);
  map.addLayer({ id: "lit-ring-glow", type: "line", source: "lit-ring", paint: { "line-color": ACCENT, "line-width": 12, "line-blur": 9, "line-opacity": 0.45 } }, under);
  map.addLayer({ id: "lit-ring-line", type: "line", source: "lit-ring", paint: { "line-color": "#e8590c", "line-width": 2 } }, under);
  map.addSource("lit-bldg", { type: "geojson", data: FC() });
  map.addLayer({ id: "lit-bldg-glow", type: "line", source: "lit-bldg", paint: { "line-color": ACCENT, "line-width": 14, "line-blur": 10, "line-opacity": 0.4 } }, under);
  map.addLayer({ id: "lit-bldg-body", type: "fill-extrusion", source: "lit-bldg", paint: { "fill-extrusion-color": ACCENT, "fill-extrusion-base": ["get", "b"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.95, "fill-extrusion-vertical-gradient": true } }, before);
  map.addLayer({ id: "lit-bldg-cap", type: "fill-extrusion", source: "lit-bldg", paint: { "fill-extrusion-color": "#ffc6a3", "fill-extrusion-base": ["get", "h"], "fill-extrusion-height": ["+", ["get", "h"], 0.7], "fill-extrusion-opacity": 0.95, "fill-extrusion-vertical-gradient": false } }, before);
  // Their ~500 m area: a soft sky disc with a feathered edge (no harsh dashes); the puck sits at its centre.
  map.addSource("them-area", { type: "geojson", data: FC() });
  map.addLayer({ id: "them-area-fill", type: "fill", source: "them-area", paint: { "fill-color": COLOR.them, "fill-opacity": 0.11 } }, under);
  map.addLayer({ id: "them-area-glow", type: "line", source: "them-area", paint: { "line-color": COLOR.them, "line-width": 10, "line-blur": 8, "line-opacity": 0.16 } }, under);
  map.addLayer({ id: "them-area-line", type: "line", source: "them-area", paint: { "line-color": COLOR.them, "line-opacity": 0.42, "line-width": 1.2 } }, under);
  // Your ~100 m accuracy ring (only for a device position, which is rounded to ~100 m).
  map.addSource("you-acc", { type: "geojson", data: FC() });
  map.addLayer({ id: "you-acc-fill", type: "fill", source: "you-acc", paint: { "fill-color": ACCENT, "fill-opacity": 0.12 } }, under);
  map.addLayer({ id: "you-acc-line", type: "line", source: "you-acc", paint: { "line-color": COLOR.you, "line-opacity": 0.4, "line-width": 1.2 } }, under);

  // Fair-middle halo: soft concentric "reach" rings, the inner one breathes.
  map.addSource("halo", { type: "geojson", data: FC() });
  map.addLayer({ id: "halo-fill", type: "fill", source: "halo", paint: { "fill-color": "#ff9a3c", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, ["interpolate", ["linear"], ["get", "r"], 250, 0.32, 600, 0.16, 1100, 0.07], 16, ["interpolate", ["linear"], ["get", "r"], 250, 0.14, 600, 0.05, 1100, 0.0]] } }, before);
  map.addLayer({ id: "halo-ring", type: "line", source: "halo", paint: { "line-color": "#cf4a0c", "line-width": 1, "line-opacity": 0.4, "line-dasharray": [1, 2] } }, before);

  // Candidate hubs the agent compares.
  map.addSource("hubs", { type: "geojson", data: FC(HUBS.map((h, i) => ({ type: "Feature", properties: { i, name: h.name }, geometry: { type: "Point", coordinates: [h.lng, h.lat] } }))) });
  map.addLayer({ id: "hubs-glow", type: "circle", source: "hubs", layout: { visibility: "none" }, paint: { "circle-radius": 18, "circle-color": ACCENT, "circle-opacity": 0.0, "circle-blur": 0.8, "circle-pitch-alignment": "map" } });
  map.addLayer({ id: "hubs-dot", type: "circle", source: "hubs", layout: { visibility: "none" }, paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": "#e8590c", "circle-stroke-width": 2, "circle-opacity": 0.9 } });
  map.addLayer({ id: "hubs-lit", type: "circle", source: "hubs", layout: { visibility: "none" }, filter: ["==", ["get", "i"], -1], paint: { "circle-radius": 8, "circle-color": ACCENT, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "hubs-label", type: "symbol", source: "hubs", layout: { visibility: "none", "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: { "text-color": "#15171c", "text-halo-color": "#fff", "text-halo-width": 1.6 } });

  // ui24: the places named in the ask while planning: a pulse, a pin and a name each, plus a soft ring at their middle.
  map.addSource("scan-focus", { type: "geojson", data: FC() });
  map.addLayer({ id: "scan-pulse", type: "circle", source: "scan-focus", layout: { visibility: "none" }, paint: { "circle-radius": 14, "circle-color": ACCENT, "circle-opacity": 0.2, "circle-stroke-color": ACCENT, "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.5, "circle-pitch-alignment": "map" } });
  map.addLayer({ id: "scan-dot", type: "circle", source: "scan-focus", layout: { visibility: "none" }, filter: ["==", ["get", "kind"], "place"], paint: { "circle-radius": 7, "circle-color": ACCENT, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "scan-mid", type: "circle", source: "scan-focus", layout: { visibility: "none" }, filter: ["==", ["get", "kind"], "mid"], paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": ACCENT, "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "scan-label", type: "symbol", source: "scan-focus", layout: { visibility: "none", "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12.5, "text-offset": [0, 1.25], "text-anchor": "top", "text-allow-overlap": true }, paint: { "text-color": "#15171c", "text-halo-color": "#fff", "text-halo-width": 2 } });

  // Per-person halo underneath (so you can still tell whose route is whose)…
  for (const who of ["them", "you"] as const) {
    map.addSource(`route-${who}`, { type: "geojson", data: EMPTY_LINE });
    map.addLayer({ id: `route-${who}-glow`, type: "line", source: `route-${who}`, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COLOR[who], "line-width": 18, "line-blur": 10, "line-opacity": 0.16 } });
    map.addLayer({ id: `route-${who}-halo`, type: "line", source: `route-${who}`, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COLOR[who], "line-width": 10.5, "line-opacity": 0.55 } });
    map.addLayer({ id: `route-${who}-case`, type: "line", source: `route-${who}`, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 7.5 } });
  }
  // …and each stretch on top in its own colour: TfL line colours, dashed bus red, dotted grey walking.
  map.addSource("route-legs", { type: "geojson", data: FC() });
  map.addLayer({ id: "legs-walk", type: "line", source: "route-legs", filter: ["==", ["get", "kind"], "walk"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 4, "line-dasharray": [0.1, 1.9] } });
  map.addLayer({ id: "legs-bus", type: "line", source: "route-legs", filter: ["==", ["get", "kind"], "bus"], layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 4.5, "line-dasharray": [2.2, 1.2] } });
  map.addLayer({ id: "legs-rail", type: "line", source: "route-legs", filter: ["==", ["get", "kind"], "rail"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 4.5 } });
  map.addLayer({ id: "legs-flow", type: "line", source: "route-legs", filter: ["==", ["get", "kind"], "rail"], layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 1.6, "line-opacity": 0.85, "line-dasharray": DASHES[0] } });
  // Footstep dots trailing the walking badge (the vehicles themselves are HTML markers, see vehicles.ts).
  map.addSource("route-dots", { type: "geojson", data: FC() });
  map.addLayer({ id: "dots-core", type: "circle", source: "route-dots", paint: { "circle-radius": ["get", "r"], "circle-color": "#7d8087", "circle-opacity": ["get", "o"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-stroke-opacity": ["get", "o"], "circle-pitch-alignment": "map" } });
  map.addLayer({ id: "legs-label", type: "symbol", source: "route-legs", filter: ["all", ["==", ["get", "kind"], "bus"], ["!=", ["get", "label"], ""]], layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-keep-upright": true }, paint: { "text-color": "#ffffff", "text-halo-color": "#DC241F", "text-halo-width": 2.4 } });
}

function el(html: string, className?: string) {
  const d = document.createElement("div");
  if (className) d.className = className;
  d.innerHTML = html;
  return d;
}

function tag(html: string, extra = "") {
  return el(`<div class="sw-tag ${extra}">${html}</div>`);
}

const PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="4.4" fill="currentColor"/><path d="M3.8 20.4c.6-4.3 4-6.9 8.2-6.9s7.6 2.6 8.2 6.9c.1.6-.3 1.1-.9 1.1H4.7c-.6 0-1-.5-.9-1.1Z" fill="currentColor"/></svg>`;

/** You / Them puck: same family as the numbered venue pins (34 px head, white ring, stem), anchored at the stem foot
 * so it stands above the 3D buildings. Tap or Enter toggles the journey time to pick #1. */
function puck(o: { who: "you" | "them"; title: string; sub?: string; eta?: string; aria: string; delay: number }) {
  const node = el(
    `<div class="sw-puck-body" style="animation-delay:${o.delay}s"><span class="sw-puck-halo" aria-hidden="true"></span><div class="sw-puck-head">${PERSON}</div><i class="sw-puck-stem"></i><i class="sw-puck-foot"></i></div>` +
      `<div class="sw-puck-tag" style="animation-delay:${o.delay + 0.15}s"><b>${o.title}</b>${o.sub ? `<small>${o.sub}</small>` : ""}${o.eta ? `<span class="sw-puck-eta">${o.eta}</span>` : ""}</div>`,
    `sw-puck sw-puck--${o.who}`
  );
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", o.aria);
  queueMicrotask(() => node.setAttribute("aria-label", o.aria)); // maplibregl.Marker overwrites it with "Map marker"
  node.setAttribute("aria-expanded", "false");
  node.tabIndex = 0;
  const toggle = (e: Event) => {
    e.stopPropagation();
    if (!o.eta) return;
    const on = !node.classList.contains("is-open");
    node.classList.toggle("is-open", on);
    node.setAttribute("aria-expanded", String(on));
  };
  node.addEventListener("click", toggle);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
  return node;
}

/** Your start as a name, only when we really know it: the first journey stretch's "from", else "I'm at X" in the ask. */
function startName(result: PlanResultWithAgent): string | null {
  const leg = result.cards[0]?.legs.find((l) => l.who === "you");
  const from = leg ? segmentsOf(leg).find((s) => s.from)?.from : undefined;
  if (from && !/your location|^you$|current/i.test(from)) return from.replace(/\s+(underground|tube|rail)?\s*station$/i, "");
  const m = (result.query || "").match(/\bI(?:'| a)?m\s+(?:at|in|near|by|around)\s+([A-Z][\w'’&. -]{2,30}?)(?=[,.;!?]|\s+(?:and|but|so|she|he|they|we)\b|$)/);
  return m ? m[1].trim() : null;
}

/** Distance in metres between two points (equirectangular is plenty at city scale). */
function metres(a: LatLng, b: LatLng) {
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 111320;
  const y = (b.lat - a.lat) * 110574;
  return Math.hypot(x, y);
}

export default function PlanMap({ result, selectedId, hoverId, focusId, scanning, scanFocus, onSelect, onHover, padding, reduced, deviceYou }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const pins = useRef<Map<string, HTMLElement>>(new Map());
  const draw = useRef<number | null>(null);
  const userBusy = useRef(0); // timestamp of the last user gesture
  const flying = useRef(false);
  const fitRef = useRef<(() => void) | null>(null);
  const padRef = useRef(padding);
  padRef.current = padding;
  // Small map (phones): own padding so fits never use the desktop panel offset.
  const pad = () => {
    const w = mapRef.current?.getContainer().clientWidth ?? 1000;
    return w < 700 ? { top: 112, right: 64, bottom: 30, left: 64 } : padRef.current;
  };
  const lastFocus = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const cb = useRef({ onSelect, onHover });
  cb.current = { onSelect, onHover };
  const deviceRef = useRef(deviceYou);
  deviceRef.current = deviceYou;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const scanRef = useRef(scanning);
  scanRef.current = scanning;
  const scanBox = useRef<HTMLDivElement>(null);
  /** Hub indices the radar lights up (near the named places, or in view). */
  const scanHubs = useRef<number[]>(HUBS.map((_, i) => i));
  /** Map point the sweep is centred on (the named places' middle), null = default position. */
  const scanAt = useRef<LatLng | null>(null);
  const focusKey = scanFocus?.places.map((p) => `${p.name}@${p.at.lat.toFixed(4)},${p.at.lng.toFixed(4)}`).join("|") ?? "";
  const focusRef = useRef(scanFocus);
  focusRef.current = scanFocus;
  const drawn = useRef(false);
  type Veh = { m: Marker; el: HTMLElement; b: HTMLElement; part: number; rest: boolean };
  const tracks = useRef<{ card: string | null; you: Track | null; them: Track | null }>({ card: null, you: null, them: null });
  const veh = useRef<{ you: Veh | null; them: Veh | null }>({ you: null, them: null });
  const statics = useRef<Marker[]>([]);
  const vehClock = useRef(0);

  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({
      container: box.current,
      style: SO_WHERE_STYLE,
      center: LONDON,
      zoom: 14.3,
      pitch: 55,
      bearing: -18,
      maxPitch: 70,
      attributionControl: false,
      fadeDuration: 0,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");
    const busy = () => (userBusy.current = performance.now());
    map.on("mousedown", busy);
    map.on("touchstart", busy);
    map.on("wheel", busy);
    map.on("dragstart", busy);
    map.on("load", () => {
      addLayers(map);
      setReady(true);
    });
    mapRef.current = map;
    // Demo links only: let screenshot scripts move the camera.
    if (/[?&]demo=/.test(window.location.search)) (window as unknown as { __swmap?: MLMap }).__swmap = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // One rAF loop for ambient motion: idle orbit, marching ants, hub scanning. Throttled to keep the map smooth.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let raf = 0;
    let last = performance.now();
    let dashT = 0;
    let dashI = 0;
    let scanT = 0;
    let scanI = 0;
    let sweepT = 0;
    let dotT = 0;
    const loop = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (!reducedRef.current) {
        // marching ants ~16 fps
        dashT += dt;
        if (dashT > 60) {
          dashT = 0;
          dashI = (dashI + 1) % DASHES.length;
          if (map.getLayer("legs-flow")) map.setPaintProperty("legs-flow", "line-dasharray", DASHES[dashI]);
        }
        // journey vehicles: every frame (2 HTML markers), clock only runs once the route is drawn and the tab is visible
        if (drawn.current && !document.hidden) {
          vehClock.current += dt;
          const dots: GeoJSON.Feature[] = [];
          (["you", "them"] as const).forEach((who) => {
            const tr = tracks.current[who];
            const v = veh.current[who];
            if (!tr || !v) return;
            const smp = sampleTrack(tr, vehClock.current);
            v.m.setLngLat(smp.at);
            if (smp.part !== v.part) {
              v.part = smp.part;
              const bd = badge(tr.parts[smp.part].st);
              v.b.className = `sw-veh-b ${bd.cls}`;
              v.b.setAttribute("style", bd.style);
              v.b.innerHTML = bd.html;
            }
            if (smp.resting !== v.rest) {
              v.rest = smp.resting;
              v.el.classList.toggle("is-rest", smp.resting);
            }
            v.el.classList.remove("is-hidden");
            setActiveSeg(tracks.current.card, who, smp.resting ? null : tr.parts[smp.part].st.seg);
            smp.trail.forEach((c, k) => dots.push({ type: "Feature", properties: { r: 2.6 - k * 0.5, o: 0.85 - k * 0.25 }, geometry: { type: "Point", coordinates: c } }));
          });
          dotT += dt;
          if (dotT > 33) {
            dotT = 0;
            (map.getSource("route-dots") as GeoJSONSource | undefined)?.setData(FC(dots));
          }
        }
        // idle orbit: only when nobody's touching the map and no camera move is running
        const idle = now - userBusy.current > 7000 && !flying.current && !map.isMoving();
        if (idle) map.setBearing(map.getBearing() + dt * (scanRef.current ? 0.006 : 0.0022));
        // scanning: light up candidate hubs one after another
        if (scanRef.current) {
          scanT += dt;
          if (scanT > 170) {
            scanT = 0;
            const set = scanHubs.current;
            scanI = (scanI + 1) % Math.max(1, set.length);
            map.setFilter("hubs-lit", ["==", ["get", "i"], set.length ? set[scanI] : -1]);
            map.setPaintProperty("hubs-glow", "circle-opacity", 0.18 + 0.12 * Math.sin(now / 300));
          }
          // pulse around the named places; keep the sweep centred on their middle as the camera moves
          if (scanAt.current) {
            const ph = (now % 1600) / 1600;
            map.setPaintProperty("scan-pulse", "circle-radius", 10 + 34 * ph);
            map.setPaintProperty("scan-pulse", "circle-opacity", 0.22 * (1 - ph));
            map.setPaintProperty("scan-pulse", "circle-stroke-opacity", 0.55 * (1 - ph));
            sweepT += dt;
            if (sweepT > 50 && scanBox.current) {
              sweepT = 0;
              const pt = map.project(ll(scanAt.current));
              scanBox.current.style.setProperty("--scan-x", `${Math.round(pt.x)}px`);
              scanBox.current.style.setProperty("--scan-y", `${Math.round(pt.y)}px`);
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      clearActiveSeg();
    };
  }, [ready]);

  // Scanning mode (ui24): with places named in the ask, fly to them, pin and pulse them, and only light up hubs near
  // them; with none, stay on the current view and scan the hubs in it (never a jump to somewhere unrelated).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const focus = scanning ? focusRef.current : null;
    const places = focus?.places ?? [];
    const vis = scanning ? "visible" : "none";
    for (const id of ["hubs-glow", "hubs-dot", "hubs-lit", "hubs-label"]) map.setLayoutProperty(id, "visibility", vis);
    for (const id of ["scan-pulse", "scan-dot", "scan-mid", "scan-label"]) map.setLayoutProperty(id, "visibility", scanning && places.length ? "visible" : "none");
    const feats: GeoJSON.Feature[] = places.map((p) => ({ type: "Feature", properties: { kind: "place", name: p.name }, geometry: { type: "Point", coordinates: ll(p.at) } }));
    if (focus?.middle && places.length > 1) feats.push({ type: "Feature", properties: { kind: "mid", name: "" }, geometry: { type: "Point", coordinates: ll(focus.middle) } });
    (map.getSource("scan-focus") as GeoJSONSource | undefined)?.setData(FC(feats));
    scanAt.current = places.length ? focus?.middle ?? places[0].at : null;
    if (!scanning) return;
    let near: number[];
    if (places.length) {
      const c = scanAt.current!;
      const span = Math.max(...places.map((p) => metres(p.at, c)));
      const reach = Math.max(1800, span * 1.6 + 600);
      near = HUBS.map((h, i) => ({ i, d: metres({ lat: h.lat, lng: h.lng }, c) })).filter((x) => x.d <= reach).sort((x, y) => x.d - y.d).slice(0, 14).map((x) => x.i);
      const b = new maplibregl.LngLatBounds();
      // Room around the places (~700 m) so the hubs and the pulse aren't on the edge.
      const pad0 = 700 / 111_000;
      places.forEach((p) => {
        b.extend([p.at.lng - pad0 * 1.6, p.at.lat - pad0]);
        b.extend([p.at.lng + pad0 * 1.6, p.at.lat + pad0]);
      });
      const cam = map.cameraForBounds(b, { padding: pad(), maxZoom: 15 });
      if (cam) {
        const o = { center: cam.center, zoom: Math.min(15, (cam.zoom ?? 14) - 0.2), pitch: 45, bearing: map.getBearing(), padding: { top: 0, right: 0, bottom: 0, left: 0 } };
        if (reduced) map.jumpTo(o);
        else {
          flying.current = true;
          map.once("moveend", () => (flying.current = false));
          map.easeTo({ ...o, duration: 1300, easing: easeInOut });
        }
      }
    } else {
      const vb = map.getBounds();
      near = HUBS.map((h, i) => ({ h, i })).filter(({ h }) => vb.contains([h.lng, h.lat])).map(({ i }) => i);
      if (!near.length) near = HUBS.map((_, i) => i);
    }
    scanHubs.current = near;
    const inSet: maplibregl.FilterSpecification = ["in", ["get", "i"], ["literal", near]];
    for (const id of ["hubs-glow", "hubs-dot", "hubs-label"]) map.setFilter(id, inSet);
    map.setFilter("hubs-lit", ["==", ["get", "i"], near[0] ?? -1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, ready, focusKey]);

  // Markers + cinematic camera: once per result.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    pins.current.clear();
    (map.getSource("them-area") as GeoJSONSource).setData(FC(result?.them ? [circle(result.them.center, result.them.radiusM)] : []));
    // ~100 m ring only when the plan started from the device position (rounded ~100 m), never a fake precise dot.
    const dev = deviceRef.current;
    const youApprox = !!(result && dev && metres(result.you, dev) < 160);
    (map.getSource("you-acc") as GeoJSONSource).setData(FC(result && youApprox ? [circle(result.you, 100)] : []));
    (map.getSource("halo") as GeoJSONSource).setData(FC(result?.middle ? [1100, 600, 250].map((r) => circle(result.middle!.location, r)) : []));
    if (!result) {
      (map.getSource("route-you") as GeoJSONSource).setData(EMPTY_LINE);
      (map.getSource("route-them") as GeoJSONSource).setData(EMPTY_LINE);
      (map.getSource("route-legs") as GeoJSONSource | undefined)?.setData(FC());
      return;
    }

    const add = (m: Marker) => {
      m.addTo(map);
      markers.current.push(m);
    };

    const top = result.cards[0];
    const etaFor = (who: "you" | "them") => {
      const m = top?.legs.find((l) => l.who === who)?.minutes;
      return m != null && top ? `${m} min to ${esc(top.name)}` : undefined;
    };
    if (result.them) {
      // Only the rounded area: its name and radius, never anything more precise.
      const area = result.them.area.replace(/\s*\(approx\.?\)\s*$/i, "").trim();
      const r = Math.round((result.them.radiusM || 500) / 50) * 50;
      // ui24: a station/area you typed is a public place: shown as itself on a small ring ("Them · Westminster").
      // Only a shared GPS fix (or a broad, approximate area) keeps the "~500 m" rounding label.
      const typed = result.them.precision === "typed" && r < 300;
      add(
        new maplibregl.Marker({
          element: puck({ who: "them", title: `Them · ${esc(typed || /\barea$/i.test(area) ? area : `${area} area`)}`, sub: typed ? "not stored" : `~${r} m · not stored`, eta: etaFor("them"), aria: typed ? `Them, at ${area} (the place you typed, not stored)` : `Them, somewhere around ${area} (about ${r} metres)`, delay: reduced ? 0 : 0.85 }),
          anchor: "bottom",
          offset: [0, 4],
        }).setLngLat(ll(result.them.center))
      );
    }

    result.cards.slice(0, 3).forEach((c, i) => {
      const node = el(
        `<div class="sw-pin-body" style="animation-delay:${reduced ? 0 : 1.1 + i * 0.14}s"><div class="sw-pin-head"><span>${i + 1}</span></div><i class="sw-pin-stem"></i></div><div class="sw-tag">${esc(c.name)}</div>`,
        "sw-pin"
      );
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `${i + 1}. ${c.name}`);
      node.tabIndex = 0;
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.current.onSelect(c.id);
      });
      node.addEventListener("mouseenter", () => cb.current.onHover(c.id));
      node.addEventListener("mouseleave", () => cb.current.onHover(null));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") cb.current.onSelect(c.id);
      });
      pins.current.set(c.id, node);
      add(new maplibregl.Marker({ element: node, anchor: "bottom", offset: [0, 2] }).setLngLat(ll(c.location)));
    });

    if (result.middle) {
      const legs = result.cards[0]?.legs ?? [];
      const you = legs.find((l) => l.who === "you")?.minutes;
      const them = legs.find((l) => l.who === "them")?.minutes;
      add(new maplibregl.Marker({ element: el("<i></i><i></i><b></b>", "sw-mid"), anchor: "center" }).setLngLat(ll(result.middle.location)));
      add(
        new maplibregl.Marker({ element: tag(`<em>Fair middle</em>${esc(result.middle.name)}${you != null && them != null ? `<small>you ${you} · them ${them} min</small>` : ""}`, "sw-mid-tag"), anchor: "right", offset: [-30, 0] }).setLngLat(ll(result.middle.location))
      );
    }

    // A snapped place without a known location has no "You" (result.you is just the place).
    const snapNoYou = (result as { snapOnly?: boolean; youKnown?: boolean }).snapOnly && !(result as { youKnown?: boolean }).youKnown;
    if (!snapNoYou) {
      const from = startName(result);
      add(
        new maplibregl.Marker({
          element: puck({ who: "you", title: `You${from ? ` · ${esc(from)}` : ""}`, sub: youApprox ? "~100 m" : undefined, eta: etaFor("you"), aria: `You${from ? `, at ${from}` : ""}`, delay: reduced ? 0 : 0.7 }),
          anchor: "bottom",
          offset: [0, 4],
        }).setLngLat(ll(result.you))
      );
    }

    fitRef.current = () => {
      const pts: LatLng[] = [result.you, ...result.cards.slice(0, 3).map((c) => c.location)];
      if (result.them) {
        const d = (result.them.radiusM || 500) / 111000;
        const { lat, lng } = result.them.center;
        pts.push({ lat: lat + d, lng: lng - d * 1.6 }, { lat: lat - d, lng: lng + d * 1.6 });
      }
      if (result.middle) pts.push(result.middle.location);
      const b = new maplibregl.LngLatBounds();
      pts.forEach((p) => b.extend(ll(p)));
      const cam = map.cameraForBounds(b, { padding: pad(), maxZoom: 15.6 });
      if (cam) {
        const opts = { center: cam.center, zoom: Math.max(9.5, (cam.zoom ?? 13) - 0.25), pitch: map.getContainer().clientWidth < 700 ? 35 : 50, bearing: -16, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
        if (reduced) map.jumpTo({ ...opts, pitch: 40, bearing: 0 });
        else {
          // Pull up and out, then dive in tilted.
          flying.current = true;
          map.once("moveend", () => (flying.current = false));
          map.flyTo({ ...opts, duration: 2600, curve: 1.6, speed: 0.9, easing: easeInOut, essential: false });
        }
      }
    };
    fitRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, ready]);

  // Hover + selection state on pins.
  useEffect(() => {
    pins.current.forEach((node, id) => {
      node.classList.toggle("is-on", id === selectedId);
      node.classList.toggle("is-hover", id === hoverId && id !== selectedId);
      node.classList.toggle("is-dim", !!hoverId && id !== hoverId && id !== selectedId);
    });
  }, [selectedId, hoverId, result, ready]);

  // Detail open: fly close to the place, tilted, so its block stands up in 3D.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !result) return;
    const card = result.cards.find((c) => c.id === focusId);
    const had = lastFocus.current;
    lastFocus.current = focusId;
    if (!card) {
      if (had) fitRef.current?.();
      return;
    }
    const o = { center: ll(card.location), zoom: 17, pitch: 62, bearing: map.getBearing() - 25, padding: pad() };
    if (reduced) map.jumpTo(o);
    else {
      flying.current = true;
      map.once("moveend", () => (flying.current = false));
      map.flyTo({ ...o, duration: 1900, curve: 1.3, easing: easeInOut });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, ready]);

  // Lit building: the selected venue's building rises in orange and breathes softly; others stay stone.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getSource("lit-bldg")) return;
    const card = focusId ? result?.cards.find((c) => c.id === focusId) : undefined;
    const bldg = map.getSource("lit-bldg") as GeoJSONSource;
    const ring = map.getSource("lit-ring") as GeoJSONSource;
    const clear = () => {
      bldg.setData(FC());
      ring.setData(FC());
      if (map.getLayer("building-3d")) map.setFilter("building-3d", null);
      delete map.getContainer().dataset.lit;
    };
    clear();
    if (!card) return;
    let raf = 0;
    let lit: string | number | null | undefined = null; // null = nothing yet
    let t0 = 0;
    const setK = (k: number) => {
      const h: maplibregl.ExpressionSpecification = ["+", ["get", "b"], ["*", ["-", ["get", "h"], ["get", "b"]], k]];
      map.setPaintProperty("lit-bldg-body", "fill-extrusion-height", h);
      map.setPaintProperty("lit-bldg-cap", "fill-extrusion-base", h);
      map.setPaintProperty("lit-bldg-cap", "fill-extrusion-height", ["+", h, 0.7]);
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const t = (now - t0) / 1000;
      const rise = Math.min(1, t / 0.9);
      setK(1 - Math.pow(1 - rise, 3));
      const breathe = rise < 1 ? 0 : 0.5 - 0.5 * Math.cos(((t - 0.9) * Math.PI * 2) / 2.4);
      map.setPaintProperty("lit-bldg-body", "fill-extrusion-opacity", 0.86 + 0.12 * breathe);
      map.setPaintProperty("lit-bldg-glow", "line-opacity", 0.22 + 0.3 * breathe);
      map.setPaintProperty("lit-ring-glow", "line-opacity", 0.25 + 0.35 * breathe);
    };
    const light = (final: boolean) => {
      const b = findBuilding(map, card.location);
      if (b) {
        if (lit !== null && lit === b.id && b.id !== undefined) return true;
        const fresh = lit === null;
        lit = b.id;
        map.getContainer().dataset.lit = b.inside ? "building" : `building-near-${b.distM}m`;
        ring.setData(FC());
        bldg.setData(FC([b.feature]));
        // Hide the stone block underneath when the tiles carry ids, so the orange one can rise from the ground.
        if (b.id !== undefined && map.getLayer("building-3d")) map.setFilter("building-3d", ["!=", ["id"], b.id]);
        if (fresh) {
          cancelAnimationFrame(raf);
          if (reducedRef.current) {
            setK(1);
            map.setPaintProperty("lit-bldg-body", "fill-extrusion-opacity", 0.95);
          } else {
            t0 = performance.now();
            raf = requestAnimationFrame(tick);
          }
        }
        return true;
      }
      if (final && lit === null) {
        // No footprint within ~25 m: a glowing ground ring instead.
        ring.setData(FC([circle(card.location, 22)]));
        map.getContainer().dataset.lit = "ring";
        if (!reducedRef.current) {
          t0 = performance.now() - 900;
          raf = requestAnimationFrame(tick);
        }
      }
      return false;
    };
    light(false);
    // Tiles near the venue may still be loading while the camera flies in (and ambient motion means "idle" rarely
    // fires): look again every 400 ms until found; after the flight plus ~2 s, settle for the ground ring.
    let tries = 0;
    const poll = window.setInterval(() => {
      if (flying.current) return;
      tries++;
      const found = light(tries >= 5);
      if (found || tries >= 5) window.clearInterval(poll);
    }, 400);
    if (process.env.NODE_ENV !== "production" || new URLSearchParams(location.search).has("debugmap")) (window as unknown as { __swmap?: MLMap }).__swmap = map;
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      clear();
      setK(1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, result, ready]);

  // Routes: progressive draw on every selection; the flow layer keeps marching afterwards.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (draw.current) cancelAnimationFrame(draw.current);
    const card = result?.cards.find((c) => c.id === selectedId) ?? result?.cards[0];
    const legs: Record<"you" | "them", Leg | undefined> = { you: card?.legs.find((l) => l.who === "you"), them: card?.legs.find((l) => l.who === "them") };
    const st = { you: legs.you ? legStretches(legs.you) : [], them: legs.them ? legStretches(legs.them) : [] };
    const full = { you: st.you.flatMap((s) => s.coords), them: st.them.flatMap((s) => s.coords) };
    drawn.current = false;
    (map.getSource("route-dots") as GeoJSONSource | undefined)?.setData(FC());
    // Vehicles: rebuild tracks + markers for this card.
    (["you", "them"] as Who[]).forEach((who) => veh.current[who]?.m.remove());
    veh.current = { you: null, them: null };
    statics.current.forEach((m) => m.remove());
    statics.current = [];
    clearActiveSeg();
    vehClock.current = 0;
    tracks.current = { card: card?.id ?? null, you: buildTrack(st.you), them: buildTrack(st.them) };
    (["you", "them"] as Who[]).forEach((who) => {
      const tr = tracks.current[who];
      if (!tr) return;
      if (reduced) {
        // Reduced motion: a static badge at the middle of each stretch, no travel.
        midpoints(tr).forEach(({ at, st: s }) => {
          const bd = badge(s);
          const el = document.createElement("div");
          el.className = `sw-veh sw-veh--${who} is-static`;
          el.setAttribute("aria-hidden", "true");
          el.innerHTML = `<span class="sw-veh-b ${bd.cls}" style="${bd.style}">${bd.html}</span>`;
          statics.current.push(new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(at).addTo(map));
        });
        return;
      }
      const el = document.createElement("div");
      el.className = `sw-veh sw-veh--${who} is-hidden`;
      el.setAttribute("aria-hidden", "true");
      const b = document.createElement("span");
      b.className = "sw-veh-b";
      el.appendChild(b);
      const m = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(tr.parts[0].st.coords[0]).addTo(map);
      veh.current[who] = { m, el, b, part: -1, rest: false };
    });
    const set = (t: number) => {
      const tt = { you: easeInOut(Math.min(1, t)), them: easeInOut(Math.min(1, Math.max(0, t - 0.12) / 0.88)) };
      (map.getSource("route-you") as GeoJSONSource | undefined)?.setData(line(partial(full.you, tt.you)));
      (map.getSource("route-them") as GeoJSONSource | undefined)?.setData(line(partial(full.them, tt.them)));
      (map.getSource("route-legs") as GeoJSONSource | undefined)?.setData(FC([...stretchFeatures(st.you, tt.you), ...stretchFeatures(st.them, tt.them)]));
    };
    if (reduced) {
      set(1);
      return; // static badges only with reduced motion
    }
    set(0);
    const delay = 700;
    const dur = 1500;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0 - delay) / dur;
      set(Math.max(0, t));
      if (t < 1) draw.current = requestAnimationFrame(tick);
      else drawn.current = true;
    };
    draw.current = requestAnimationFrame(tick);
    return () => {
      if (draw.current) cancelAnimationFrame(draw.current);
    };
  }, [result, selectedId, ready, reduced]);

  return (
    <div className="absolute inset-0" role="region" aria-label="Map of the plan">
      <div ref={box} className="sw-map h-full w-full" />
      {scanning ? <div ref={scanBox} className={`sw-scan pointer-events-none absolute inset-0${scanFocus?.places.length ? " is-focus" : ""}`} aria-hidden /> : null}
    </div>
  );
}
