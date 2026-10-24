"use client";

import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Plus, ShieldCheck, X } from "lucide-react";
import { LONDON_AREAS } from "@/lib/areas";
import { DAY_LABEL, WEEK, type DayKey } from "@/lib/hours";
import { currentUserId, requestSignIn, takeIntent, useUser } from "@/lib/auth";
import { addSession, VOUCHES_NEEDED } from "@/lib/pending-sessions";

const field = "mt-1.5 h-11 w-full rounded-xl border border-[#e7e5ed] bg-white px-3 font-normal outline-none focus:border-[#b9a7fb] focus:ring-2 focus:ring-[#7854f6]/10";

export function HostCoworkDialog() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [f, setF] = useState({ title: "", organiser: "", venue_name: "", address: "", area: LONDON_AREAS[0].name, day_of_week: "fri" as DayKey, start_time: "10:00", end_time: "17:00", price: "Free", url: "", note: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const user = useUser();

  // Resume after sign-in: reopen the form, with anything typed before.
  useEffect(() => {
    if (!user) return;
    const intent = takeIntent("host-session");
    if (!intent) return;
    if (intent.draft) setF((p) => ({ ...p, ...(intent.draft as Partial<typeof p>) }));
    setOpen(true);
  }, [user]);

  async function start() {
    if (await currentUserId()) setOpen(true);
    else requestSignIn({ type: "host-session" });
  }

  function close() {
    setOpen(false);
    setTimeout(() => {
      setDone(null);
      setError(null);
      setF((p) => ({ ...p, title: "", venue_name: "", address: "", url: "", note: "" }));
    }, 250);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim() || !f.venue_name.trim() || f.end_time <= f.start_time) return;
    setBusy(true);
    setError(null);
    const res = await addSession({ ...f, title: f.title.trim(), organiser: f.organiser.trim(), venue_name: f.venue_name.trim(), address: f.address.trim(), url: f.url.trim(), note: f.note.trim() });
    setBusy(false);
    if (!res.ok) {
      if (res.signIn) {
        setOpen(false);
        requestSignIn({ type: "host-session", draft: f });
        return;
      }
      return setError(res.error);
    }
    setDone({ title: f.title.trim() });
  }

  return (
    <>
      <button type="button" onClick={() => void start()} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[#20202a] px-3 text-xs font-semibold !text-white hover:bg-[#383845]">
        <Plus className="h-3.5 w-3.5" /> Host a cowork session
      </button>
      {mounted ? createPortal(<AnimatePresence>
        {open ? (
          <motion.div className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-[#20202a]/20 p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close}>
            <motion.div role="dialog" aria-modal="true" aria-label="Host a cowork session" onClick={(e) => e.stopPropagation()}
              className="my-6 w-full max-w-lg rounded-3xl border border-[#ecebf0] bg-white p-6 text-[#20202a] shadow-[0_24px_60px_rgba(35,30,65,0.15)]"
              initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.98 }} transition={{ type: "spring", stiffness: 320, damping: 28 }}>
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8473c2]">For founders and communities</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em]">Host a cowork session</h2>
                  <p className="mt-1 text-sm text-[#6f6d78]">Invite others to work alongside you every week.</p>
                </div>
                <button type="button" onClick={close} aria-label="Close" className="rounded-lg p-1.5 text-[#85838f] hover:bg-[#f4f3f7]"><X className="h-5 w-5" /></button>
              </div>
              {done ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-2xl bg-[#f3fbf6] p-4">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#2f9e62]" />
                    <div>
                      <p className="font-medium">{done.title} is waiting for vouches</p>
                      <p className="mt-1 text-sm leading-6 text-[#5f6b64]">It joins "This week you can cowork with others" once {VOUCHES_NEEDED} organisers vouch for it.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <a href="/review" className="inline-flex h-11 items-center justify-center rounded-xl border border-[#e2dcf7] text-sm font-medium !text-[#5a3fd6] hover:bg-[#faf9ff]">Open review queue</a>
                    <button type="button" onClick={close} className="h-11 rounded-xl bg-[#7854f6] text-sm font-medium !text-white hover:bg-[#6842eb]">Done</button>
                  </div>
                </div>
              ) : (
                <form onSubmit={submit} className="grid gap-3 text-sm font-medium">
                  <label>Session name<input required value={f.title} onChange={set("title")} maxLength={120} placeholder="e.g. Founders deep-work Tuesdays" className={field} /></label>
                  <label>Community or organiser<input value={f.organiser} onChange={set("organiser")} maxLength={120} placeholder="e.g. Hoxton Founders (no personal names or contacts)" className={field} /></label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label>Venue<input required value={f.venue_name} onChange={set("venue_name")} maxLength={120} placeholder="e.g. The Library café" className={field} /></label>
                    <label>Address or postcode<input value={f.address} onChange={set("address")} maxLength={200} placeholder="e.g. EC1V 9HX" className={field} /></label>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <label>Day<select value={f.day_of_week} onChange={set("day_of_week")} className={field}>{WEEK.map((d) => <option key={d} value={d}>{DAY_LABEL[d]}</option>)}</select></label>
                    <label>Start<input type="time" value={f.start_time} onChange={set("start_time")} className={field} /></label>
                    <label>End<input type="time" value={f.end_time} onChange={set("end_time")} className={field} /></label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label>Area<select value={f.area} onChange={set("area")} className={field}>{LONDON_AREAS.map((a) => <option key={a.name}>{a.name}</option>)}</select></label>
                    <label>Price<input value={f.price} onChange={set("price")} maxLength={60} placeholder="Free" className={field} /></label>
                  </div>
                  <label>Sign-up link (Luma, Meetup…)<input type="url" value={f.url} onChange={set("url")} maxLength={300} placeholder="https://luma.com/…" className={field} /></label>
                  <label>What to expect<textarea rows={2} value={f.note} onChange={set("note")} maxLength={500} placeholder="Quiet focus blocks, lunch together at 1pm, wifi" className="mt-1.5 w-full rounded-xl border border-[#e7e5ed] px-3 py-2 font-normal outline-none focus:border-[#b9a7fb]" /></label>
                  {f.end_time <= f.start_time ? <p className="text-xs text-[#9e4038]">End time needs to be after the start.</p> : null}
                  <p className="flex items-start gap-1.5 text-xs font-normal leading-5 text-[#92909b]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#7854f6]" /> No personal contact details. Sessions need {VOUCHES_NEEDED} vouches before they show publicly.</p>
                  {error ? <p role="alert" className="rounded-xl bg-[#fff6f5] px-3 py-2 text-sm font-normal text-[#9e4038]">{error}</p> : null}
                  <button type="submit" disabled={busy || !f.title.trim() || !f.venue_name.trim()} className="h-11 rounded-xl bg-[#7854f6] font-medium !text-white hover:bg-[#6842eb] disabled:opacity-50">{busy ? "Saving…" : "Submit for vouching"}</button>
                </form>
              )}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>, document.body) : null}
    </>
  );
}
