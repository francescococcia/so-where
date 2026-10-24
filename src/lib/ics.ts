import type { CommunityEvent } from "./events";

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatUtc(value: string): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  let output = "";
  let segment = "";
  let bytes = 0;

  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      output += segment + "\r\n ";
      segment = "";
      bytes = 1;
    }
    segment += character;
    bytes += size;
  }

  return output + segment;
}

/** Build an RFC 5545 iCalendar document using CRLF line endings. */
export function eventsToIcs(events: readonly CommunityEvent[], generatedAt: Date = new Date()): string {
  const stamp = formatUtc(generatedAt.toISOString()) ?? "19700101T000000Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lumap//London Events//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Lumap London Events",
  ];

  for (const event of events) {
    const start = formatUtc(event.start_at);
    if (!start) continue;
    const end = event.end_at ? formatUtc(event.end_at) : undefined;
    const safeId = encodeURIComponent(event.id || event.title).replace(/%/g, "_");

    lines.push(
      "BEGIN:VEVENT",
      "UID:" + safeId + "@lumap.local",
      "DTSTAMP:" + stamp,
      "DTSTART:" + start,
      ...(end && end > start ? ["DTEND:" + end] : []),
      "SUMMARY:" + escapeText(event.title),
      ...(event.url && /^https?:\/\//i.test(event.url) ? ["URL:" + event.url.replace(/[\r\n]/g, "")] : []),
      ...(event.reasons.length ? ["DESCRIPTION:" + escapeText(event.reasons.join("; "))] : []),
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
