"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { CalendarPlus, Clock, ExternalLink, MapPin, Users } from "lucide-react";
import { coworkSessions, coworkWeek, isWeekly, type CoworkItem } from "@/lib/cowork";
import { NEW_TAB, sessionLink } from "@/lib/links";
import { listSessions, SESSIONS_CHANGE_EVENT } from "@/lib/pending-sessions";
import { HostCoworkDialog } from "@/components/host-cowork-dialog";

function useHostedSessions(): CoworkItem[] {
  const [hosted, setHosted] = useState<CoworkItem[]>([]);
  useEffect(() => {
    const load = () =>
      setHosted(
        listSessions()
          .filter((s) => s.status === "verified")
          .map((s) => ({
            key: s.id,
            title: s.title,
            organiser: s.organiser || null,
            use_case: "cowork",
            day_of_week: s.day_of_week,
            start_time: s.start_time,
            end_time: s.end_time,
            cadence: "weekly",
            price: s.price || null,
            rsvp: s.url ? "Register via the host's link" : null,
            url: s.url || null,
            summary: s.note || null,
            venue_name: s.venue_name,
            lat: s.lat,
            lng: s.lng,
            area: s.area,
            with_others: true,
            audience: "Community hosted, vouched by 2 organisers",
            community: true,
          })),
      );
    load();
    window.addEventListener(SESSIONS_CHANGE_EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(SESSIONS_CHANGE_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);
  return hosted;
}

export function CoworkWeek({ onShow, highlightDay, compact }: { onShow?: (s: CoworkItem) => void; highlightDay?: string; compact?: boolean }) {
  const hosted = useHostedSessions();
  const [now, setNow] = useState<Date | null>(null);
  const [host, setHost] = useState("lumap-self.vercel.app");
  useEffect(() => {
    setNow(new Date());
    setHost(window.location.host);
  }, []);
  const groups = useMemo(() => (now ? coworkWeek([...coworkSessions(), ...hosted], now) : []), [now, hosted]);
  const webcal = `webcal://${host}/api/cowork.ics`;
  const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;

  return (
    <section id="cowork-week" aria-label="This week you can cowork with others" className="rounded-2xl border border-[#d9cffd] bg-gradient-to-br from-[#f4f0ff] to-[#fdf6fa] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#6a4ee0]">
            <Users className="h-3.5 w-3.5" /> Work alongside other people
          </p>
          <h2 className="mt-1 text-base font-semibold tracking-[-0.02em] text-[#20202a]">This week you can cowork with others</h2>
          <p className="mt-0.5 text-xs leading-5 text-[#6f6d78]">Regular sessions where founders and builders work side by side. No need to pick a day.</p>
        </div>
      </div>
      <div className="mt-3 grid gap-3">
        {groups.map((g) => (
          <div key={g.day}>
            <p className={`mb-1.5 text-xs font-semibold ${highlightDay === g.day ? "text-[#c2185b]" : "text-[#45434e]"}`}>{g.label}</p>
            <div className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
              {g.sessions.map((s) => {
                const link = sessionLink(s);
                return (
                  <motion.article key={s.key} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl bg-white p-3 ring-1 ring-[#ece7fd]">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold leading-snug text-[#20202a]">{s.title}</h3>
                      {s.community ? <span className="shrink-0 rounded-full bg-[#e8f7ef] px-2 py-0.5 text-[10px] font-semibold text-[#2f7a50]">Community hosted</span> : null}
                    </div>
                    <p className="mt-1 flex items-center gap-1 text-xs text-[#5f5d6a]"><Clock className="h-3 w-3" /> {s.start_time}–{s.end_time}{isWeekly(s) ? "" : ` · ${s.cadence}`}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-[#5f5d6a]"><MapPin className="h-3 w-3" /> {s.venue_name} · {s.area}</p>
                    {s.audience ? <p className="mt-0.5 text-xs text-[#85838f]">For: {s.audience}</p> : null}
                    <p className="mt-1 text-xs font-medium text-[#7a1d45]">{[s.price, s.rsvp].filter(Boolean).join(" · ")}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {link ? (
                        <a href={link.url} {...NEW_TAB} className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#7854f6] px-2.5 text-xs font-semibold !text-white hover:bg-[#6842eb]">
                          <ExternalLink className="h-3 w-3" /> {link.label}
                        </a>
                      ) : null}
                      {onShow ? (
                        <button type="button" onClick={() => onShow(s)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#e2dcf7] bg-white px-2.5 text-xs font-medium text-[#5a3fd6] hover:bg-[#faf9ff]">
                          <MapPin className="h-3 w-3" /> Show on map
                        </button>
                      ) : (
                        <a href={`/?session=${encodeURIComponent(s.key)}`} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#e2dcf7] bg-white px-2.5 text-xs font-medium !text-[#5a3fd6] hover:bg-[#faf9ff]">
                          <MapPin className="h-3 w-3" /> Show on map
                        </a>
                      )}
                    </div>
                  </motion.article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#e7e0fb] pt-3">
        <HostCoworkDialog />
        <a href={google} {...NEW_TAB} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#e2dcf7] bg-white px-3 text-xs font-medium !text-[#30303a] hover:bg-[#faf9ff]">
          <CalendarPlus className="h-3.5 w-3.5 text-[#7854f6]" /> Subscribe to coworking
        </a>
        <a href={webcal} className="text-xs font-medium !text-[#7854f6] hover:underline">Apple / Outlook</a>
      </div>
    </section>
  );
}
