"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng, Leg, PlanResultWithAgent } from "@/lib/plan-types";
import hubsDoc from "@/data/hubs.json";
import { SO_WHERE_STYLE } from "./map-style";
import { legStretches, type MapStretch } from "./journey";
import { badge, buildTrack, clearActiveSeg, midpoints, sampleTrack, setActiveSeg, type Track, type Who } from "./vehicles";

/** Idle view: the South Bank, tilted, so the 3D city is the first thing you see. */
const LONDON: [number, number] = [-0.1135, 51.5065];
const HUBS = (hubsDoc as { hubs: { name: string; lat: number; lng: number }[] }).hubs;

export type MapPadding = { top: number; right: number; bottom: number; left: number };

type Props = {
  result: PlanResultWithAgent | null;
  selectedId: string | null;
  hoverId: string | null;
  focusId: string | null;
  scanning: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  padding: MapPadding;
  reduced: boolean;
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
  map.addSource("them-area", { type: "geojson", data: FC() });
  map.addLayer({ id: "them-area-fill", type: "fill", source: "them-area", paint: { "fill-color": "#1478a3", "fill-opacity": 0.08 } }, before);
  map.addLayer({ id: "them-area-line", type: "line", source: "them-area", paint: { "line-color": "#1478a3", "line-opacity": 0.6, "line-width": 1.6, "line-dasharray": [2, 2] } }, before);

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

export default function PlanMap({ result, selectedId, hoverId, focusId, scanning, onSelect, onHover, padding, reduced }: Props) {
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
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const scanRef = useRef(scanning);
  scanRef.current = scanning;
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
            scanI = (scanI + 1) % HUBS.length;
            map.setFilter("hubs-lit", ["==", ["get", "i"], scanI]);
            map.setPaintProperty("hubs-glow", "circle-opacity", 0.18 + 0.12 * Math.sin(now / 300));
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

  // Scanning mode: hubs visible, camera pulls back over central London.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const vis = scanning ? "visible" : "none";
    for (const id of ["hubs-glow", "hubs-dot", "hubs-lit", "hubs-label"]) map.setLayoutProperty(id, "visibility", vis);
    if (scanning) {
      map.setFilter("hubs-lit", ["==", ["get", "i"], 0]);
      const b = new maplibregl.LngLatBounds();
      HUBS.forEach((h) => b.extend([h.lng, h.lat]));
      const cam = map.cameraForBounds(b, { padding: pad(), maxZoom: 14 });
      if (cam) {
        const o = { center: cam.center, zoom: (cam.zoom ?? 13) - 0.4, pitch: 45, bearing: map.getBearing(), padding: { top: 0, right: 0, bottom: 0, left: 0 } };
        if (reduced) map.jumpTo(o);
        else {
          flying.current = true;
          map.once("moveend", () => (flying.current = false));
          map.easeTo({ ...o, duration: 1400, easing: easeInOut });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, ready]);

  // Markers + cinematic camera: once per result.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    pins.current.clear();
    (map.getSource("them-area") as GeoJSONSource).setData(FC(result?.them ? [circle(result.them.center, result.them.radiusM)] : []));
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

    if (result.them) {
      add(new maplibregl.Marker({ element: tag(`${esc(`Their area · ${result.them.area}`)}<small>rounded ~${Math.round(result.them.radiusM)} m · not stored</small>`, "sw-area-tag"), anchor: "center" }).setLngLat(ll(result.them.center)));
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

    add(new maplibregl.Marker({ element: el("<i></i><b></b>", "sw-you"), anchor: "center" }).setLngLat(ll(result.you)));
    add(new maplibregl.Marker({ element: tag("You"), anchor: "left", offset: [16, 0] }).setLngLat(ll(result.you)));

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
    const o = { center: ll(card.location), zoom: 16.4, pitch: 60, bearing: map.getBearing() - 25, padding: pad() };
    if (reduced) map.jumpTo(o);
    else {
      flying.current = true;
      map.once("moveend", () => (flying.current = false));
      map.flyTo({ ...o, duration: 1900, curve: 1.3, easing: easeInOut });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, ready]);

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
      {scanning ? <div className="sw-scan pointer-events-none absolute inset-0" aria-hidden /> : null}
    </div>
  );
}
