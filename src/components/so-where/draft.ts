// Friendly "Send plan" text, built on the device from the result. Never includes the other person's area.
import type { PlanCard, PlanResult } from "@/lib/plan-types";
import { segmentsOf } from "./journey";
import { splitSubtitle } from "./plan-card";

const TZ = "Europe/London";

function shortAddress(a: string) {
  return a
    .replace(/\bStreet\b/g, "St")
    .replace(/\bRoad\b/g, "Rd")
    .replace(/\bSt\.\s/g, "St ")
    .replace(/\s+/g, " ")
    .trim();
}

function whenText(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(d);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day.replace(",", "")} at ${t}`;
}

/** "(near London Bridge station)" from the server draft, else nothing. */
export function nearStation(result: PlanResult, card: PlanCard) {
  const m = result.draftMessage.match(/\(near ([^)]+?)(?: station)?\)/i) ?? card.why.match(/\bfrom ([A-Z][\w' ]+?) station\b/);
  return m ? m[1].trim() : result.middle?.name ?? "";
}

const BAD = /severe|part closure|suspended|closed|no service/i;

/** One short clause if a line the recipient actually uses has a severe delay or (part) closure. */
function disruption(result: PlanResult, card: PlanCard) {
  const leg = card.legs.find((l) => l.who === "them");
  if (!leg) return "";
  const lines = segmentsOf(leg).map((s) => s.line?.replace(/\s+line$/i, "").toLowerCase()).filter(Boolean) as string[];
  if (!lines.length) return "";
  const status = card.facts.filter((f) => /train|line|status/i.test(f.label)).map((f) => f.value).join(" · ");
  for (const part of status.split(/\s·\s|;\s*/)) {
    const [name, ...rest] = part.split(":");
    const s = rest.join(":");
    if (!BAD.test(s)) continue;
    const n = name.replace(/\s+line$/i, "").trim();
    if (lines.some((l) => l === n.toLowerCase())) {
      const what = /part closure/i.test(s) ? "part closure" : /suspend/i.test(s) ? "suspension" : /closed|no service/i.test(s) ? "closure" : "severe delays";
      return `Heads up: ${n} has ${what} right now.`;
    }
  }
  return "";
}

export function friendlyDraft(result: PlanResult, card: PlanCard | undefined, opts: { maps?: boolean } = {}): string {
  if (!card) return result.draftMessage;
  const { type, address } = splitSubtitle(card.subtitle);
  const near = nearStation(result, card);
  const addr = [shortAddress(address), near && !address.toLowerCase().includes(near.toLowerCase()) ? `near ${near}` : ""].filter(Boolean).join(", ");
  const place = addr ? `${card.name} (${addr})` : card.name;
  const when = whenText(result.when);
  const them = card.legs.find((l) => l.who === "them")?.minutes;
  const coffee = /coffee|caf[eé]/i.test(`${type} ${result.filters.category ?? ""}`);

  let ask: string;
  if (card.kind === "event") ask = `Hey! Want to come to ${place}${when ? ` on ${when}` : ""}?`;
  else if (coffee) ask = `Hey! Fancy a coffee at ${place}${when ? ` on ${when}` : ""}?`;
  else if (result.intent === "meet_halfway") ask = `Hey! Fancy meeting at ${place}${when ? ` on ${when}` : ""}?`;
  else ask = `Hey! Fancy ${place}${when ? ` on ${when}` : ""}?`;

  const parts = [ask];
  if (them) parts.push(`It's about ${them} min for you 🙂`);
  const d = disruption(result, card);
  if (d) parts.push(d);
  let text = parts.join(" ");
  if (opts.maps !== false) text += `\nhttps://maps.google.com/?q=${card.location.lat.toFixed(5)},${card.location.lng.toFixed(5)}`;

  // Belt and braces: their area never goes in the message.
  const area = result.them?.area;
  if (area && text.toLowerCase().includes(area.toLowerCase())) text = text.split(new RegExp(area.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join("the middle");
  return text;
}
