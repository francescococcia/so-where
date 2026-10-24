"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MLMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng, Leg, PlanResultWithAgent } from "@/lib/plan-types";

const POSITRON = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const LONDON: [number, number] = [-0.105, 51.505];

export type MapPadding = { top: number; right: number; bottom: number; left: number };

type Props = {
  result: PlanResultWithAgent | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  padding: MapPadding;
  reduced: boolean;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ll = (p: LatLng): [number, number] => [p.lng, p.lat];
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function circle(center: LatLng, radiusM: number, steps = 72) {
  const coords: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [coords] } };
}

const line = (coords: [number, number][]) => ({ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } });
const EMPTY_LINE = line([]);

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

/** Warm the Positron basemap into a stone-and-slate street atlas. */
function restyle(map: MLMap) {
  for (const l of map.getStyle().layers ?? []) {
    const id = l.id.toLowerCase();
    try {
      if (l.type === "background") map.setPaintProperty(l.id, "background-color", "#eeede8");
      else if (l.type === "fill" && /water/.test(id)) map.setPaintProperty(l.id, "fill-color", "#c6d4db");
      else if (l.type === "fill" && /park|wood|grass|cemetery|pitch|garden/.test(id)) map.setPaintProperty(l.id, "fill-color", "#dde4d2");
      else if (l.type === "fill" && /building/.test(id)) map.setPaintProperty(l.id, "fill-color", "#e3e1da");
      else if (l.type === "fill" && /landuse|residential/.test(id)) map.setPaintProperty(l.id, "fill-color", "#ebeae4");
      else if (l.type === "line" && /waterway|river/.test(id)) map.setPaintProperty(l.id, "line-color", "#c6d4db");
      else if (l.type === "symbol" && /place|label/.test(id)) map.setPaintProperty(l.id, "text-color", "#5f626a");
    } catch {
      /* layer without that paint property */
    }
  }
}

function addLayers(map: MLMap) {
  map.addSource("them-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "them-area-fill", type: "fill", source: "them-area", paint: { "fill-color": "#e1251b", "fill-opacity": 0.08 } });
  map.addLayer({ id: "them-area-line", type: "line", source: "them-area", paint: { "line-color": "#b81d14", "line-opacity": 0.6, "line-width": 1.5, "line-dasharray": [2, 2] } });
  for (const who of ["them", "you"] as const) {
    map.addSource(`route-${who}`, { type: "geojson", data: EMPTY_LINE });
    map.addLayer({ id: `route-${who}-case`, type: "line", source: `route-${who}`, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 8 } });
    map.addLayer({ id: `route-${who}`, type: "line", source: `route-${who}`, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": who === "you" ? "#15171c" : "#e1251b", "line-width": 4.5 } });
  }
}

function el(html: string, className?: string) {
  const d = document.createElement("div");
  if (className) d.className = className;
  d.innerHTML = html;
  return d;
}

/** Callout label. Wrapped so its entrance animation doesn't fight maplibre's positioning transform. */
function tag(html: string, extra = "") {
  return el(`<div class="sw-tag ${extra}">${html}</div>`);
}

export default function PlanMap({ result, selectedId, onSelect, padding, reduced }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const pins = useRef<Map<string, HTMLElement>>(new Map());
  const anim = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({
      container: box.current,
      style: POSITRON,
      center: LONDON,
      zoom: 11.4,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("load", () => {
      restyle(map);
      addLayers(map);
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      if (anim.current) cancelAnimationFrame(anim.current);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Markers + camera: once per result.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    pins.current.clear();
    (map.getSource("them-area") as GeoJSONSource).setData({ type: "FeatureCollection", features: result?.them ? [circle(result.them.center, result.them.radiusM)] : [] });
    if (!result) {
      (map.getSource("route-you") as GeoJSONSource).setData(EMPTY_LINE);
      (map.getSource("route-them") as GeoJSONSource).setData(EMPTY_LINE);
      return;
    }

    const add = (m: Marker) => {
      m.addTo(map);
      markers.current.push(m);
    };

    // Them: rounded area, explicitly not stored.
    if (result.them) {
      add(new maplibregl.Marker({ element: tag(`${esc(`Their area · ${result.them.area}`)}<small>rounded ~${Math.round(result.them.radiusM)} m · not stored</small>`, "sw-area-tag"), anchor: "center" }).setLngLat(ll(result.them.center)));
    }

    // Numbered pins.
    result.cards.slice(0, 3).forEach((c, i) => {
      const node = el(`<div class="sw-pin-body" style="animation-delay:${reduced ? 0 : 0.55 + i * 0.12}s"><div class="sw-pin-head"><span>${i + 1}</span></div></div><div class="sw-tag">${esc(c.name)}</div>`, "sw-pin");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `${i + 1}. ${c.name}`);
      node.tabIndex = 0;
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelectRef.current(c.id);
      });
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") onSelectRef.current(c.id);
      });
      pins.current.set(c.id, node);
      add(new maplibregl.Marker({ element: node, anchor: "bottom", offset: [0, 4] }).setLngLat(ll(c.location)));
    });

    // Middle.
    if (result.middle) {
      const legs = result.cards[0]?.legs ?? [];
      const you = legs.find((l) => l.who === "you")?.minutes;
      const them = legs.find((l) => l.who === "them")?.minutes;
      add(new maplibregl.Marker({ element: el("<i></i><b></b>", "sw-mid"), anchor: "center" }).setLngLat(ll(result.middle.location)));
      add(
        new maplibregl.Marker({ element: tag(`Fair middle · ${esc(result.middle.name)}${you != null && them != null ? `<small>you ${you} · them ${them} min</small>` : ""}`), anchor: "right", offset: [-26, 0] }).setLngLat(ll(result.middle.location))
      );
    }

    // You.
    add(new maplibregl.Marker({ element: el("<i></i><b></b>", "sw-you"), anchor: "center" }).setLngLat(ll(result.you)));
    add(new maplibregl.Marker({ element: tag("You"), anchor: "left", offset: [16, 0] }).setLngLat(ll(result.you)));

    // Camera: frame everyone, then settle on the middle.
    const pts: LatLng[] = [result.you, ...result.cards.slice(0, 3).map((c) => c.location)];
    if (result.them) pts.push(result.them.center);
    if (result.middle) pts.push(result.middle.location);
    const b = new maplibregl.LngLatBounds();
    pts.forEach((p) => b.extend(ll(p)));
    const cam = map.cameraForBounds(b, { padding, maxZoom: 15.5 });
    if (cam) {
      const opts = { center: cam.center, zoom: cam.zoom ?? 13, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
      // cameraForBounds already offsets the centre for the padding.
      if (reduced) map.jumpTo(opts);
      else map.flyTo({ ...opts, duration: 1800, curve: 1.25, easing: easeInOut, essential: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, ready]);

  // Selected pin + routes: draw in on every selection.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    pins.current.forEach((node, id) => node.classList.toggle("is-on", id === selectedId));
    if (anim.current) cancelAnimationFrame(anim.current);
    const card = result?.cards.find((c) => c.id === selectedId) ?? result?.cards[0];
    const legs: Record<"you" | "them", Leg | undefined> = { you: card?.legs.find((l) => l.who === "you"), them: card?.legs.find((l) => l.who === "them") };
    const full = {
      you: (legs.you?.path ?? []).map(ll),
      them: (legs.them?.path ?? []).map(ll),
    };
    const set = (t: number) => {
      (map.getSource("route-you") as GeoJSONSource | undefined)?.setData(line(partial(full.you, easeInOut(Math.min(1, t)))));
      (map.getSource("route-them") as GeoJSONSource | undefined)?.setData(line(partial(full.them, easeInOut(Math.min(1, Math.max(0, t - 0.12) / 0.88)))));
    };
    if (reduced) {
      set(1);
      return;
    }
    set(0);
    const delay = 350;
    const dur = 1300;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0 - delay) / dur;
      set(Math.max(0, t));
      if (t < 1) anim.current = requestAnimationFrame(tick);
    };
    anim.current = requestAnimationFrame(tick);
  }, [result, selectedId, ready, reduced]);

  // maplibre sets position:relative on its container, so size it from a wrapper.
  return (
    <div className="absolute inset-0" role="region" aria-label="Map of the plan">
      <div ref={box} className="h-full w-full" />
    </div>
  );
}
