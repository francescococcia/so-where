"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { NEW_TAB, eventLinkLabel } from "@/lib/links";
import { CoworkWeek } from "@/components/cowork-week";
import { ArrowLeft, CalendarPlus, Check, Clock, Copy, ExternalLink, Laptop, Rss, Search, Sparkles, X } from "lucide-react";

const COWORK_RE = /co-?work|deep work|work session|founder|builders? (club|day|session)|hack ?night|work together|laptop/i;

export type FeedEvent = {
  id: string;
  title: string;
  url: string | null;
  start_at: string;
  end_at: string | null;
  reasons: string[];
  score: number;
};

function gcalDate(iso: string) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function googleAddLink(event: FeedEvent) {
  const start = gcalDate(event.start_at);
  const end = gcalDate(event.end_at ?? new Date(Date.parse(event.start_at) + 2 * 3600_000).toISOString());
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${start}/${end}`,
    details: [event.reasons.join(" · "), event.url ?? ""].filter(Boolean).join("\n"),
    location: "London",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" });
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "Europe/London" });
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "Europe/London" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

export function EventsFeed({ events }: { events: FeedEvent[] }) {
  const [host, setHost] = useState("lumap-self.vercel.app");
  const [copied, setCopied] = useState(false);
  useEffect(() => setHost(window.location.host), []);

  const feedHttps = `https://${host}/api/calendar.ics`;
  const feedWebcal = `webcal://${host}/api/calendar.ics`;
  const googleSubscribe = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(feedWebcal)}`;

  const [when, setWhen] = useState<"all" | "week" | "next" | "later">("all");
  const [sort, setSort] = useState<"top" | "soon">("top");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [cowork, setCowork] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("chip") === "cowork" || window.location.hash === "#cowork") setCowork(true);
  }, []);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) for (const r of e.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r]) => r);
  }, [events]);

  const visible = useMemo(() => {
    const now = Date.now();
    const week = 7 * 86400_000;
    const q = query.trim().toLowerCase();
    const list = events.filter((e) => {
      const t = Date.parse(e.start_at) - now;
      if (when === "week" && t > week) return false;
      if (when === "next" && (t <= week || t > 2 * week)) return false;
      if (when === "later" && t <= 2 * week) return false;
      if (tag && !e.reasons.includes(tag)) return false;
      if (cowork && !COWORK_RE.test(`${e.title} ${e.reasons.join(" ")}`)) return false;
      if (q && !`${e.title} ${e.reasons.join(" ")}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sort === "soon" ? [...list].sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at)) : list;
  }, [events, when, tag, query, sort, cowork]);

  const WHEN = [
    { id: "all", label: "Any time" },
    { id: "week", label: "This week" },
    { id: "next", label: "Next week" },
    { id: "later", label: "Later" },
  ] as const;

  async function copy() {
    try {
      await navigator.clipboard.writeText(feedHttps);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <main className="min-h-screen bg-[#fafaf7] px-4 py-6 text-[#20202a] sm:px-8 sm:py-10">
      <div className="mx-auto w-full max-w-6xl">
        <a href="/" className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-[#666570] transition-colors hover:text-[#7854f6]">
          <ArrowLeft className="h-4 w-4" /> Back to the map
        </a>

        <motion.section
          id="subscribe"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mt-6 overflow-hidden rounded-3xl border border-[#ecebf0] bg-white shadow-[0_12px_40px_rgba(35,30,65,0.06)]"
        >
          <div className="bg-gradient-to-br from-[#efe9ff] via-[#f7f4ff] to-[#e8f7ef] p-6 sm:p-8">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#8473c2]">
              <Sparkles className="h-4 w-4" /> Ranked London community events
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">Events feed</h1>
            <p className="mt-2 max-w-xl text-[15px] leading-7 text-[#5f5d6a]">
              Subscribe once and the best upcoming community events land in your calendar automatically. The feed updates itself, so there's nothing to download or re-import.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <a href={googleSubscribe} {...NEW_TAB} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#7854f6] px-4 text-sm font-medium !text-white shadow-[0_8px_20px_rgba(120,84,246,0.25)] transition-transform hover:bg-[#6842eb] active:scale-[0.98]">
                <Rss className="h-4 w-4" /> Subscribe in Google Calendar
              </a>
              <a href={feedWebcal} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#e2dcf7] bg-white px-4 text-sm font-medium text-[#30303a] transition-colors hover:bg-[#faf9ff]">
                <CalendarPlus className="h-4 w-4 text-[#7854f6]" /> Apple or Outlook
              </a>
              <button type="button" onClick={copy} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#e2dcf7] bg-white px-4 text-sm font-medium text-[#30303a] transition-colors hover:bg-[#faf9ff]">
                {copied ? <Check className="h-4 w-4 text-[#2f9e62]" /> : <Copy className="h-4 w-4 text-[#7854f6]" />}
                {copied ? "Link copied" : "Copy feed link"}
              </button>
            </div>
          </div>
        </motion.section>

        <div className="sticky top-0 z-10 -mx-4 mt-6 border-b border-[#ecebf0] bg-[#fafaf7]/90 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a98a3]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search events" className="h-10 w-full rounded-xl border border-[#e7e5ed] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#b9a7fb] focus:ring-2 focus:ring-[#7854f6]/10" />
            </div>
            <div role="radiogroup" aria-label="When" className="flex rounded-xl bg-[#f1eff6] p-1">
              {WHEN.map((w) => (
                <button key={w.id} type="button" role="radio" aria-checked={when === w.id} onClick={() => setWhen(w.id)} className={`relative rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${when === w.id ? "!text-white" : "text-[#5f5d6a] hover:text-[#20202a]"}`}>
                  {when === w.id ? <motion.span layoutId="when-pill" className="absolute inset-0 rounded-lg bg-[#7854f6]" transition={{ type: "spring", stiffness: 400, damping: 32 }} /> : null}
                  <span className="relative">{w.label}</span>
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Sort" className="flex rounded-xl border border-[#e7e5ed] bg-white p-1">
              {([["top", "Top ranked"], ["soon", "Soonest"]] as const).map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={sort === id} onClick={() => setSort(id)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${sort === id ? "bg-[#f4f0ff] text-[#5a3fd6]" : "text-[#6f6d78] hover:text-[#20202a]"}`}>{label}</button>
              ))}
            </div>
          </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={cowork} onClick={() => setCowork(!cowork)} className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ring-1 transition-colors ${cowork ? "bg-[#20202a] !text-white ring-[#20202a]" : "bg-[#f4f0ff] text-[#5a3fd6] ring-[#d9cffd] hover:ring-[#b9a7fb]"}`}>
                <Laptop className="h-3 w-3" /> Coworking{cowork ? <X className="h-3 w-3" /> : null}
              </button>
              {tags.map((t) => (
                <button key={t} type="button" onClick={() => setTag(tag === t ? null : t)} className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${tag === t ? "bg-[#7854f6] !text-white ring-[#7854f6]" : "bg-white text-[#5f5d6a] ring-[#ece7fd] hover:ring-[#cbbcfb]"}`}>
                  {t}{tag === t ? <X className="h-3 w-3" /> : null}
                </button>
              ))}
            </div>
          <p className="mt-2 text-xs text-[#85838f]">{visible.length} of {events.length} events</p>
        </div>

        {cowork ? (
          <div className="mt-5">
            <CoworkWeek />
            <p className="mt-4 text-sm font-semibold text-[#45434e]">One-off coworking and founder events</p>
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-[#e2dff0] bg-white p-8 text-center text-sm text-[#85838f]">
            No events match these filters.{" "}
            <button type="button" className="font-medium text-[#7854f6]" onClick={() => { setWhen("all"); setTag(null); setQuery(""); setCowork(false); }}>Clear filters</button>
          </div>
        ) : null}

        <motion.div layout className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {visible.map((event, index) => {
              const start = new Date(event.start_at);
              return (
                <motion.article
                  key={event.id || event.title + event.start_at}
                  layout
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  whileHover={{ y: -3 }}
                  transition={{ type: "spring", stiffness: 300, damping: 28, delay: Math.min(index * 0.03, 0.4) }}
                  className="flex h-full flex-col rounded-2xl border border-[#ecebf0] bg-white p-4 shadow-[0_1px_2px_rgba(32,32,42,0.04)] hover:shadow-[0_12px_30px_rgba(35,30,65,0.08)]"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid w-14 shrink-0 place-items-center rounded-xl bg-[#f4f0ff] py-2 text-center">
                      <span className="text-[11px] font-semibold uppercase text-[#8473c2]">{dayFmt.format(start)}</span>
                      <span className="text-xl font-semibold leading-tight text-[#20202a]">{dateFmt.format(start)}</span>
                      <span className="text-[11px] text-[#8a8894]">{monthFmt.format(start)}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="line-clamp-3 font-semibold leading-snug text-[#20202a]">{event.title}</h2>
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-[#6f6d78]"><Clock className="h-3.5 w-3.5" /> {timeFmt.format(start)} · London</p>
                    </div>
                  </div>
                  {event.reasons.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {event.reasons.map((reason) => (
                        <button key={reason} type="button" onClick={() => setTag(reason)} className="rounded-full bg-[#faf9ff] px-2.5 py-0.5 text-xs text-[#5f5d6a] ring-1 ring-[#ece7fd] hover:ring-[#cbbcfb]">{reason}</button>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-auto flex gap-2 pt-4">
                    <a href={googleAddLink(event)} {...NEW_TAB} aria-label={`Add ${event.title} to Google Calendar`} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#7854f6] px-3 text-xs font-medium !text-white hover:bg-[#6842eb]">
                      <CalendarPlus className="h-3.5 w-3.5" /> Add to calendar
                    </a>
                    {event.url ? (
                      <a href={event.url} {...NEW_TAB} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#e8e7ed] px-3 text-xs font-medium text-[#30303a] hover:bg-[#faf9ff]">
                        <ExternalLink className="h-3.5 w-3.5" /> {eventLinkLabel(event.url)}
                      </a>
                    ) : null}
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </motion.div>
      </div>
    </main>
  );
}
