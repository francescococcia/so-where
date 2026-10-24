"use client";

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const POSITRON = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export type MapPin = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  status: string | null;
  fit?: "covers" | "unknown" | "ask";
  kind?: string;
  note?: string;
  session?: boolean;
};

type VenueMapProps = {
  pins: MapPin[];
  center: { lat: number; lng: number };
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  hoveredId?: string | null;
  onHover?: (id: string | null) => void;
  fitKey?: number;
  /** When set, the next fit (fitKey change) frames only these pins. */
  fitIds?: string[] | null;
  /** Where distances are measured from; drawn as a "You" (or area-centre) marker. */
  origin?: { lat: number; lng: number; label: string; kind: string } | null;
  /** When true, the next click on the map sets the origin. */
  picking?: boolean;
  onPick?: (lat: number, lng: number) => void;
};

if (typeof document !== "undefined" && !document.getElementById("lumap-pin-css")) {
  const style = document.createElement("style");
  style.id = "lumap-pin-css";
  style.textContent = `
@keyframes lumapPinIn { 0% { transform: translateY(-18px) scale(0.4); opacity: 0 } 60% { transform: translateY(2px) scale(1.12); opacity: 1 } 100% { transform: translateY(0) scale(1); opacity: 1 } }
@keyframes lumapPulse { 0% { box-shadow: 0 0 0 0 rgba(120,84,246,0.45) } 100% { box-shadow: 0 0 0 16px rgba(120,84,246,0) } }
.lumap-pin { cursor: pointer; }
.lumap-pin-dot { width: 28px; height: 28px; border-radius: 999px; border: 3px solid #fff; color: #fff; font: 600 12px/22px system-ui, sans-serif; text-align: center; box-shadow: 0 4px 12px rgba(32,32,42,0.25); transition: transform .2s ease, background .2s ease; animation: lumapPinIn .55s cubic-bezier(.2,.8,.2,1) both; }
.lumap-pin:hover .lumap-pin-dot { transform: scale(1.15); }
.lumap-pin.is-selected .lumap-pin-dot { transform: scale(1.25); animation: lumapPulse 1.4s ease-out infinite; border-color: #7854f6; }
.lumap-pin.is-hover .lumap-pin-dot { transform: scale(1.2); }
.lumap-pin.is-pending .lumap-pin-dot { border-style: dashed; }
.lumap-pin.is-session .lumap-pin-dot { box-shadow: 0 0 0 3px #e0457b, 0 6px 16px rgba(224,69,123,0.45); }
.lumap-pin-star { position: absolute; top: -7px; right: -7px; width: 16px; height: 16px; border-radius: 999px; background: #e0457b; color: #fff; border: 2px solid #fff; font: 700 8px/12px system-ui, sans-serif; text-align: center; pointer-events: none; }
.lumap-pin-tip { position: absolute; bottom: 36px; left: 50%; transform: translate(-50%, 4px); white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .15s ease, transform .15s ease; background: #fff; color: #20202a; border: 1px solid #ecebf0; border-radius: 12px; padding: 6px 10px; font: 500 12px/1.35 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(32,32,42,0.12); }
.lumap-pin-tip b { display: block; font-weight: 600; }
.lumap-pin-tip span { color: #6f6d78; }
.lumap-pin:hover .lumap-pin-tip, .lumap-pin.is-hover .lumap-pin-tip, .lumap-pin.is-selected .lumap-pin-tip { opacity: 1; transform: translate(-50%, 0); }
.lumap-pin:hover, .lumap-pin.is-hover, .lumap-pin.is-selected { z-index: 5; }
.lumap-origin { display: flex; flex-direction: column; align-items: center; pointer-events: none; }
.lumap-origin-label { background: #20202a; color: #fff; border-radius: 999px; padding: 3px 9px; font: 600 11px/1.3 system-ui, sans-serif; box-shadow: 0 4px 12px rgba(32,32,42,0.25); white-space: nowrap; margin-bottom: 4px; }
.lumap-origin-dot { width: 18px; height: 18px; border-radius: 999px; background: #2563eb; border: 3px solid #fff; box-shadow: 0 0 0 6px rgba(37,99,235,0.18), 0 2px 8px rgba(32,32,42,0.3); }
.lumap-origin.is-area .lumap-origin-dot { background: #20202a; width: 12px; height: 12px; box-shadow: 0 0 0 5px rgba(32,32,42,0.12); }
.lumap-origin.is-area .lumap-origin-label { background: #fff; color: #20202a; border: 1px solid #e4e2ea; }
.lumap-picking, .lumap-picking canvas { cursor: crosshair !important; }
`;
  document.head.appendChild(style);
}

export const FIT_COLOR = { covers: "#2faf78", unknown: "#e39b2b", ask: "#7854f6" } as const;

function pinColor(pin: MapPin) {
  if (pin.fit) return FIT_COLOR[pin.fit];
  return pin.status === "pending" ? "#e39b2b" : pin.status === "suggested" ? "#7854f6" : "#2faf78";
}

function fitPadding() {
  const wide = typeof window !== "undefined" && window.innerWidth > 900;
  return wide ? { top: 80, bottom: 110, left: 430, right: 90 } : 60;
}

export function VenueMap({ pins, center, selectedId, onSelect, hoveredId, onHover, fitKey, fitIds, origin, picking, onPick }: VenueMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const initialCenter = useRef(center);
  const loadedRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const originMarker = useRef<maplibregl.Marker | null>(null);
  const originRef = useRef(origin);
  originRef.current = origin;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const start = initialCenter.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: POSITRON,
      center: [start.lng, start.lat],
      zoom: 11.5,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    map.on("click", (e) => {
      if (pickingRef.current) onPickRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });
    map.once("load", () => {
      loadedRef.current = true;
    });
    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const draw = () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = pins.map((pin, index) => {
        const el = document.createElement("div");
        el.className = "lumap-pin";
        el.dataset.id = pin.id;
        if (pin.status === "pending") el.classList.add("is-pending");
        if (pin.session) el.classList.add("is-session");
        el.setAttribute("aria-label", pin.name);
        const dot = document.createElement("div");
        dot.className = "lumap-pin-dot";
        dot.textContent = String(index + 1);
        dot.style.background = pinColor(pin);
        dot.style.animationDelay = `${index * 0.12}s`;
        el.appendChild(dot);
        if (pin.session) {
          const star = document.createElement("span");
          star.className = "lumap-pin-star";
          star.textContent = "★";
          el.appendChild(star);
        }
        const tip = document.createElement("div");
        tip.className = "lumap-pin-tip";
        const b = document.createElement("b");
        b.textContent = pin.name.replace(/^EXAMPLE · /, "");
        const line = document.createElement("span");
        line.textContent = [pin.kind, pin.note].filter(Boolean).join(" · ");
        tip.append(b, line);
        el.appendChild(tip);
        el.addEventListener("mouseenter", () => onHoverRef.current?.(pin.id));
        el.addEventListener("mouseleave", () => onHoverRef.current?.(null));
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelectRef.current?.(pin.id);
        });
        return new maplibregl.Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map);
      });

      if (pins.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        pins.forEach((pin) => bounds.extend([pin.lng, pin.lat]));
        const o = originRef.current;
        if (o) bounds.extend([o.lng, o.lat]);
        map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 14, duration: 700 });
      } else {
        map.easeTo({ center: [center.lng, center.lat], zoom: 12, duration: 700 });
      }
    };

    // loaded() is false while tiles stream in, even after the first load,
    // so remember the load event instead of asking every time.
    if (loadedRef.current) draw();
    else map.once("load", draw);
  }, [pins, center]);

  useEffect(() => {
    const map = mapRef.current;
    markersRef.current.forEach((marker) => {
      const el = marker.getElement();
      el.classList.toggle("is-selected", el.dataset.id === selectedId);
    });
    const pin = pins.find((item) => item.id === selectedId);
    if (map && pin) {
      map.flyTo({ center: [pin.lng, pin.lat], zoom: 15, offset: [-120, 0], duration: 900, essential: true });
    }
  }, [selectedId, pins]);

  useEffect(() => {
    markersRef.current.forEach((marker) => {
      const el = marker.getElement();
      el.classList.toggle("is-hover", el.dataset.id === hoveredId);
    });
  }, [hoveredId, pins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitKey || pins.length === 0) return;
    const only = fitIds?.length ? pins.filter((pin) => fitIds.includes(pin.id)) : [];
    const bounds = new maplibregl.LngLatBounds();
    (only.length ? only : pins).forEach((pin) => bounds.extend([pin.lng, pin.lat]));
    map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 14, duration: 700 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    originMarker.current?.remove();
    originMarker.current = null;
    if (!origin) return;
    const el = document.createElement("div");
    el.className = `lumap-origin${origin.kind === "area" ? " is-area" : ""}`;
    const label = document.createElement("div");
    label.className = "lumap-origin-label";
    label.textContent = origin.kind === "area" ? `${origin.label} centre` : origin.kind === "postcode" ? `You · ${origin.label}` : "You";
    const dot = document.createElement("div");
    dot.className = "lumap-origin-dot";
    el.append(label, dot);
    originMarker.current = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, 9] }).setLngLat([origin.lng, origin.lat]).addTo(map);
  }, [origin]);

  useEffect(() => {
    containerRef.current?.classList.toggle("lumap-picking", Boolean(picking));
  }, [picking]);

  return <div ref={containerRef} className="h-full w-full" data-testid="venue-map" />;
}
