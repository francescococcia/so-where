// Outbound links for venues, sessions and events. All open in a new tab.

import { venueSources, type Session, type VenueLike } from "@/lib/venue-facts";

export const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;

const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

// Google Maps search for the venue: name plus address (or postcode), else the pin.
export function directionsUrl(v: { name?: string | null; address?: string | null; lat?: number | null; lng?: number | null }) {
  const name = (v.name ?? "").replace(/^EXAMPLE · /, "").trim();
  const address = (v.address ?? "").trim();
  let query: string;
  if (address && POSTCODE.test(address)) query = !name || address.toLowerCase().includes(name.toLowerCase()) ? address : `${name}, ${address}`;
  else if (v.lat != null && v.lng != null) query = `${v.lat},${v.lng}`;
  else query = [name, address, "London"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Pages that list a venue rather than being its own site.
const LISTING = /(luma\.com|lu\.ma|tagvenue\.com|coworkinglondon\.com|litme\.events|secretldn\.com|meetup\.com|ealingculture\.org|wixsite\.com|cavitarestaurant\.com)/i;

export function venueSite(v: VenueLike): { url: string; label: string } | null {
  const sources = venueSources(v);
  const official = sources.find((u) => !LISTING.test(u));
  if (official) return { url: official, label: "Venue site" };
  if (sources[0]) return { url: sources[0], label: "Listing" };
  return null;
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function sessionLink(s: Pick<Session, "url" | "source_url" | "source_urls">): { url: string; label: string } | null {
  const url = s.url ?? s.source_url ?? s.source_urls?.[0] ?? null;
  if (!url) return null;
  return { url, label: /(^|\.)(luma\.com|lu\.ma)$/i.test(hostOf(url)) ? "Register on Luma" : "Event page" };
}

export function eventLinkLabel(url: string) {
  return /(^|\.)(luma\.com|lu\.ma)$/i.test(hostOf(url)) ? "Register on Luma" : "Event page";
}
