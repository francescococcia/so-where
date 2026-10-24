"use client";
// Real, freely licensed place photos (Wikimedia Commons via /api/photo), a styled fallback when none is found,
// and the one-line "Why here" built only from data the result already carries.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Beer, Coffee, Landmark, MapPin, Palette, Star, Store, Ticket, Trees, UtensilsCrossed, Wine, type LucideIcon } from "lucide-react";
import type { PlanCard as Card, PlanResult } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { findFact, openAnswer } from "./answers";
import { fmtTime } from "./format";
import { nearStation } from "./draft";
import { cardArea } from "./blurb";
import { readWeather } from "./map-chips";
import { splitSubtitle } from "./plan-card";

export type Photo = { url: string; width: number; height: number; page: string; author?: string; license?: string; source: string };

const cache = new Map<string, Photo | null>();
const inflight = new Map<string, Promise<Photo | null>>();

function load(card: Card): Promise<Photo | null> {
  const key = card.id;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  if (!inflight.has(key)) {
    const q = new URLSearchParams({ name: card.name, lat: card.location.lat.toFixed(5), lng: card.location.lng.toFixed(5) });
    if (/^osm-(node|way|relation)-\d+$/.test(card.id)) q.set("osm", card.id);
    inflight.set(
      key,
      fetch(`/api/photo?${q}`)
        .then((r) => (r.ok ? r.json() : { photo: null }))
        .then((d: { photo: Photo | null }) => (cache.set(key, d.photo ?? null), d.photo ?? null))
        .catch(() => null)
        .finally(() => inflight.delete(key))
    );
  }
  return inflight.get(key)!;
}

/** undefined while loading, null when there's no real photo. */
export function usePhoto(card: Card): Photo | null | undefined {
  const [p, setP] = useState<Photo | null | undefined>(() => (cache.has(card.id) ? cache.get(card.id) : undefined));
  useEffect(() => {
    let live = true;
    if (cache.has(card.id)) setP(cache.get(card.id));
    else {
      setP(undefined);
      load(card).then((x) => live && setP(x));
    }
    return () => {
      live = false;
    };
  }, [card]);
  return p;
}

const ICONS: [RegExp, LucideIcon][] = [
  [/pub|bar|tavern|inn/i, Beer],
  [/wine/i, Wine],
  [/caf[eé]|coffee/i, Coffee],
  [/restaurant|food|kitchen|dining/i, UtensilsCrossed],
  [/museum|library|church|historic/i, Landmark],
  [/gallery|art/i, Palette],
  [/market|shop/i, Store],
  [/park|garden|common/i, Trees],
  [/event|gig|talk|meetup|show/i, Ticket],
];
export function categoryIcon(card: Card): LucideIcon {
  const t = `${splitSubtitle(card.subtitle).type} ${card.kind}`;
  return ICONS.find(([re]) => re.test(t))?.[1] ?? MapPin;
}

/** Warm gradient + category icon. Shown when there is no real photo; never a stock image. */
function Fallback({ card, big }: { card: Card; big?: boolean }) {
  const Icon = categoryIcon(card);
  return (
    <div className="sw-photo-fallback absolute inset-0 grid place-items-center" aria-hidden>
      <Icon className={cn("text-white drop-shadow-[0_2px_6px_rgba(120,30,0,.35)]", big ? "size-12" : "size-6")} strokeWidth={1.75} />
    </div>
  );
}

export function PhotoThumb({ card, className }: { card: Card; className?: string }) {
  const photo = usePhoto(card);
  const [ok, setOk] = useState(true);
  return (
    <span className={cn("relative block shrink-0 overflow-hidden rounded-[12px] bg-sunk shadow-e1 ring-1 ring-black/5", className)}>
      {photo === undefined ? <span className="sw-photo-skel absolute inset-0" aria-hidden /> : photo && ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <motion.img src={photo.url} alt="" loading="lazy" decoding="async" onError={() => setOk(false)} initial={{ opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.45 }} className="absolute inset-0 size-full object-cover" />
      ) : (
        <Fallback card={card} />
      )}
    </span>
  );
}

/** Google-Maps-style hero with credit. */
export function PhotoHero({ card }: { card: Card }) {
  const photo = usePhoto(card);
  const [ok, setOk] = useState(true);
  const credit = photo ? [photo.author, photo.license].filter(Boolean).join(" · ") : "";
  return (
    <figure className="relative aspect-[16/9] w-full overflow-hidden rounded-[18px] bg-sunk shadow-e2 ring-1 ring-black/5">
      {photo === undefined ? <span className="sw-photo-skel absolute inset-0" aria-hidden /> : photo && ok ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <motion.img src={photo.url} alt={`Photo of ${card.name}`} decoding="async" onError={() => setOk(false)} initial={{ opacity: 0, scale: 1.05 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="absolute inset-0 size-full object-cover" />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/45 to-transparent" />
          <figcaption className="absolute bottom-1.5 right-2 max-w-[85%] truncate text-[10.5px] font-medium text-white/95 [text-shadow:0_1px_2px_rgba(0,0,0,.5)]">
            <a href={photo.page} target="_blank" rel="noopener noreferrer" title={credit || undefined} className="hover:underline">
              Photo: {photo.author ? `${photo.author}, ` : ""}Wikimedia Commons{photo.license ? ` (${photo.license})` : ""}
            </a>
          </figcaption>
        </>
      ) : (
        <>
          <Fallback card={card} big />
          <figcaption className="absolute bottom-1.5 right-2 text-[10.5px] font-medium text-white/90">No photo found</figcaption>
        </>
      )}
    </figure>
  );
}

/** Renders only when real rating data exists (e.g. a future Google Places key). Never fabricated. */
export function RatingSlot({ rating }: { rating?: { value: number; count: number; source: string } }) {
  if (!rating || !Number.isFinite(rating.value) || !rating.count) return null;
  return (
    <p className="flex items-center gap-1 text-[13px] text-ink-2">
      <span className="num font-semibold text-ink">{rating.value.toFixed(1)}</span>
      <Star className="size-3.5 fill-signal text-signal" aria-hidden />
      <span className="num">({rating.count.toLocaleString("en-GB")})</span>
      <span className="text-ink-3">· {rating.source}</span>
    </p>
  );
}

/** "Pub · Borough" (area = station area or postcode district). */
export function placeMeta(result: PlanResult, card: Card) {
  const { type, address } = splitSubtitle(card.subtitle);
  const area = cardArea(card) || nearStation(result, card) || address.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/)?.[1] || "";
  return [type || (card.kind === "event" ? "Event" : ""), area].filter(Boolean).join(" · ");
}

/** One short, friendly line from real result data only. */
export function whyHere(result: PlanResult, card: Card): string {
  const { type } = splitSubtitle(card.subtitle);
  const kind = (type || (card.kind === "event" ? "Event" : "Spot")).replace(/^\w/, (c) => c.toUpperCase());
  const station = nearStation(result, card) || cardArea(card).match(/\bnear (.+)$/i)?.[1] || "";
  const walk = card.legs.map((l) => l.summary.match(/~?(\d{1,2})\s*min(?:ute)?s?\s*walk/i)?.[1]).find(Boolean);
  const w = findFact(card, /weather|forecast/i);
  const wx = w ? readWeather(w.value) : null;
  const evening = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(new Date(result.when))) >= 17;
  const indoor = !/park|market|garden|common/i.test(type);
  const lead = `${wx?.wet && indoor ? `Indoor ${kind.toLowerCase()}` : kind}${station ? (walk ? `, ${walk} min from ${station}` : ` near ${station}`) : ""}`;
  const extras: string[] = [];
  if (wx?.wet && indoor) extras.push(`good for a rainy ${evening ? "evening" : "day"}`);
  else if (wx && !wx.wet && wx.hint === "Terrace weather") extras.push("terrace weather");
  const [a, b] = [card.legs.find((l) => l.who === "you"), card.legs.find((l) => l.who === "them")];
  if (a && b && Math.abs(a.minutes - b.minutes) <= 4) extras.push(`a fair split (${a.minutes} vs ${b.minutes} min)`);
  else if (a && !b && !station) extras.push(`${a.minutes} min from you`);
  const price = findFact(card, /price|entry|fee|cost/i);
  if (price && /^free\b/i.test(price.value.trim())) extras.push("free entry");
  const open = openAnswer(card, result.when);
  if (open.state === true && card.kind === "venue") extras.push(`open at ${fmtTime(result.when)}`);
  if (/quiet/i.test(card.why)) extras.push("on the quieter side");
  return `${[lead, ...extras.slice(0, 2)].join(", ")}.`;
}
