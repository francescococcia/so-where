"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CheckCircle2, ShieldCheck, Undo2, Users, X } from "lucide-react";
import { listSessions, rejectSession, revokeSession, SESSIONS_CHANGE_EVENT, vouchSession, type PendingSession } from "@/lib/pending-sessions";
import { DAY_LABEL } from "@/lib/hours";
import { CHANGE_EVENT, listVenues, rejectVenue, revokeVenue, vouchVenue, VOUCHES_NEEDED, type PendingVenue } from "@/lib/pending-venues";
import { AuthMenu } from "@/components/auth-menu";
import { requestSignIn, takeIntent, useUser } from "@/lib/auth";
import type { Result, Vote } from "@/lib/submissions";

type Kind = "venue" | "session";
const ACTIONS: Record<Kind, Record<Vote | "revoke", (id: string) => Promise<Result>>> = {
  venue: { vouch: vouchVenue, reject: rejectVenue, revoke: revokeVenue },
  session: { vouch: vouchSession, reject: rejectSession, revoke: revokeSession },
};

export default function ReviewPage() {
  const [notice, setNotice] = useState<{ id: string; text: string; ok?: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const user = useUser();
  async function act(id: string, kind: Kind, action: Vote | "revoke") {
    if (!user && action !== "revoke") {
      requestSignIn({ type: "vote", id, kind, vote: action });
      return;
    }
    setBusyId(id);
    setNotice(null);
    const res = await ACTIONS[kind][action](id);
    setBusyId(null);
    if (!res.ok) {
      if (res.signIn && action !== "revoke") requestSignIn({ type: "vote", id, kind, vote: action });
      setNotice({ id, text: res.error });
    } else if (action === "revoke") setNotice({ id, text: "Your vote is withdrawn.", ok: true });
  }
  // Resume a vouch/reject that was started before signing in.
  useEffect(() => {
    if (!user) return;
    const intent = takeIntent("vote");
    if (intent) void act(intent.id, intent.kind, intent.vote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  const [venues, setVenues] = useState<PendingVenue[]>([]);
  useEffect(() => {
    const load = () => setVenues(listVenues());
    load();
    window.addEventListener(CHANGE_EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(CHANGE_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);

  const [sessions, setSessions] = useState<PendingSession[]>([]);
  useEffect(() => {
    const load = () => setSessions(listSessions());
    load();
    window.addEventListener(SESSIONS_CHANGE_EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(SESSIONS_CHANGE_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);
  const pendingSessions = sessions.filter((s) => s.status === "pending");
  const doneSessions = sessions.filter((s) => s.status !== "pending");

  const pending = venues.filter((v) => v.status === "pending");
  const done = venues.filter((v) => v.status !== "pending");

  return (
    <main className="min-h-screen bg-[#fafaf7] px-4 py-6 text-[#20202a] sm:px-8 sm:py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <a href="/" className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-[#666570] transition-colors hover:text-[#7854f6]">
            <ArrowLeft className="h-4 w-4" /> Back to the map
          </a>
          <AuthMenu />
        </div>
        <section className="mt-6 rounded-3xl border border-[#ecebf0] bg-gradient-to-br from-[#efe9ff] via-[#f7f4ff] to-[#e8f7ef] p-6 sm:p-8">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#8473c2]"><ShieldCheck className="h-4 w-4" /> Organiser review</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">Review queue</h1>
          <p className="mt-2 max-w-xl text-[15px] leading-7 text-[#5f5d6a]">
            New venues and cowork sessions need {VOUCHES_NEEDED} vouches from different organisers. Anyone can read this queue. To vote, sign in with your email: one vote per person per item, no vouching for your own submissions, and you can withdraw your vote later. {VOUCHES_NEEDED} rejections take an item off the queue; once vouched, it goes live on the map and in the weekly cowork list.
          </p>
        </section>

        <h2 className="mt-8 mb-3 text-sm font-semibold text-[#45434e]">Waiting for vouches ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[#e2dff0] bg-white p-6 text-center text-sm text-[#85838f]">
            Nothing to review. Use <strong>Add venue</strong> on the map to suggest a room.
          </p>
        ) : null}
        <div className="grid gap-3">
          <AnimatePresence>
            {pending.map((v) => (
              <motion.article key={v.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} className="rounded-2xl border border-[#ecebf0] bg-white p-5 shadow-[0_1px_2px_rgba(32,32,42,0.04)]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-semibold">{v.name}</h3>
                    <p className="mt-0.5 text-sm text-[#6f6d78]">{[v.address, v.area].filter(Boolean).join(", ")}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-[#85838f]"><Users className="h-3.5 w-3.5" /> Fits {v.capacity ?? "?"}</p>
                    {v.note ? <p className="mt-2 text-sm leading-6 text-[#484751]">{v.note}</p> : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-[#fff4e0] px-2.5 py-1 text-xs font-semibold text-[#a86a10]">{v.vouches} of {VOUCHES_NEEDED} vouches</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#f1eff6]">
                  <motion.div className="h-full rounded-full bg-[#7854f6]" animate={{ width: `${(v.vouches / VOUCHES_NEEDED) * 100}%` }} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {v.myVote ? (
                    <>
                      <span className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#f1edff] text-sm font-medium text-[#5a3fd6]">
                        {v.myVote === "vouch" ? <ShieldCheck className="h-4 w-4" /> : <X className="h-4 w-4" />} {v.myVote === "vouch" ? "You vouched" : "You rejected this"}
                      </span>
                      <button type="button" disabled={busyId === v.id} onClick={() => act(v.id, "venue", "revoke")} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#e8e7ed] px-4 text-sm font-medium text-[#6f6d78] hover:bg-[#f4f3f7] disabled:opacity-50">
                        <Undo2 className="h-4 w-4" /> Withdraw my vote
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={busyId === v.id} onClick={() => act(v.id, "venue", "vouch")} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#7854f6] text-sm font-medium !text-white hover:bg-[#6842eb] disabled:opacity-50">
                        <ShieldCheck className="h-4 w-4" /> Vouch, I've hosted here
                      </button>
                      <button type="button" disabled={busyId === v.id} onClick={() => act(v.id, "venue", "reject")} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#e8e7ed] px-4 text-sm font-medium text-[#6f6d78] hover:bg-[#fff6f5] hover:text-[#9e4038] disabled:opacity-50">
                        <X className="h-4 w-4" /> Reject
                      </button>
                    </>
                  )}
                </div>
                {v.mine ? <p className="mt-2 text-xs text-[#85838f]">You submitted this, so it needs vouches from {VOUCHES_NEEDED} other people.</p> : null}
                {notice?.id === v.id ? <p role="status" className={`mt-2 text-sm ${notice.ok ? "text-[#2f9e62]" : "text-[#9e4038]"}`}>{notice.text}</p> : null}
              </motion.article>
            ))}
          </AnimatePresence>
        </div>

        <h2 className="mt-8 mb-3 text-sm font-semibold text-[#45434e]">Cowork sessions waiting for vouches ({pendingSessions.length})</h2>
        {pendingSessions.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[#e2dff0] bg-white p-6 text-center text-sm text-[#85838f]">
            No sessions to review. Use <strong>Host a cowork session</strong> under "Cowork with others" to invite people to work alongside you.
          </p>
        ) : null}
        <div className="grid gap-3">
          <AnimatePresence>
            {pendingSessions.map((s) => (
              <motion.article key={s.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} className="rounded-2xl border border-[#ecebf0] bg-white p-5 shadow-[0_1px_2px_rgba(32,32,42,0.04)]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#8473c2]">Cowork session</p>
                    <h3 className="font-semibold">{s.title}</h3>
                    <p className="mt-0.5 text-sm text-[#6f6d78]">Every {DAY_LABEL[s.day_of_week]} {s.start_time}–{s.end_time} · {[s.venue_name, s.address, s.area].filter(Boolean).join(", ")}</p>
                    <p className="mt-0.5 text-xs text-[#85838f]">{[s.organiser, s.price].filter(Boolean).join(" · ")}</p>
                    {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs font-medium !text-[#7854f6] hover:underline">{s.url}</a> : null}
                    {s.note ? <p className="mt-2 text-sm leading-6 text-[#484751]">{s.note}</p> : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-[#fff4e0] px-2.5 py-1 text-xs font-semibold text-[#a86a10]">{s.vouches} of {VOUCHES_NEEDED} vouches</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#f1eff6]">
                  <motion.div className="h-full rounded-full bg-[#7854f6]" animate={{ width: `${(s.vouches / VOUCHES_NEEDED) * 100}%` }} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {s.myVote ? (
                    <>
                      <span className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#f1edff] text-sm font-medium text-[#5a3fd6]">
                        {s.myVote === "vouch" ? <ShieldCheck className="h-4 w-4" /> : <X className="h-4 w-4" />} {s.myVote === "vouch" ? "You vouched" : "You rejected this"}
                      </span>
                      <button type="button" disabled={busyId === s.id} onClick={() => act(s.id, "session", "revoke")} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#e8e7ed] px-4 text-sm font-medium text-[#6f6d78] hover:bg-[#f4f3f7] disabled:opacity-50">
                        <Undo2 className="h-4 w-4" /> Withdraw my vote
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={busyId === s.id} onClick={() => act(s.id, "session", "vouch")} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#7854f6] text-sm font-medium !text-white hover:bg-[#6842eb] disabled:opacity-50">
                        <ShieldCheck className="h-4 w-4" /> Vouch, I know this session
                      </button>
                      <button type="button" disabled={busyId === s.id} onClick={() => act(s.id, "session", "reject")} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#e8e7ed] px-4 text-sm font-medium text-[#6f6d78] hover:bg-[#fff6f5] hover:text-[#9e4038] disabled:opacity-50">
                        <X className="h-4 w-4" /> Reject
                      </button>
                    </>
                  )}
                </div>
                {s.mine ? <p className="mt-2 text-xs text-[#85838f]">You submitted this, so it needs vouches from {VOUCHES_NEEDED} other people.</p> : null}
                {notice?.id === s.id ? <p role="status" className={`mt-2 text-sm ${notice.ok ? "text-[#2f9e62]" : "text-[#9e4038]"}`}>{notice.text}</p> : null}
              </motion.article>
            ))}
          </AnimatePresence>
        </div>
        {doneSessions.length ? (
          <div className="mt-3 grid gap-2">
            {doneSessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-2xl border border-[#ecebf0] bg-white px-4 py-3">
                <div className="flex items-center gap-2 text-sm">
                  {s.status === "verified" ? <CheckCircle2 className="h-4 w-4 text-[#2f9e62]" /> : <X className="h-4 w-4 text-[#9e4038]" />}
                  <span className="font-medium">{s.title}</span>
                  <span className="text-[#85838f]">{s.status === "verified" ? "in the cowork list" : "rejected"}</span>
                </div>
                {s.status === "verified" && s.myVote === "vouch" ? (
                  <button type="button" disabled={busyId === s.id} onClick={() => act(s.id, "session", "revoke")} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[#6f6d78] hover:bg-[#f4f3f7]">
                    <Undo2 className="h-3.5 w-3.5" /> Revoke my vouch
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {done.length ? (
          <>
            <h2 className="mt-8 mb-3 text-sm font-semibold text-[#45434e]">Decided</h2>
            <div className="grid gap-2">
              {done.map((v) => (
                <motion.div key={v.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-between rounded-2xl border border-[#ecebf0] bg-white px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    {v.status === "verified" ? <CheckCircle2 className="h-4 w-4 text-[#2f9e62]" /> : <X className="h-4 w-4 text-[#9e4038]" />}
                    <span className="font-medium">{v.name}</span>
                    <span className="text-[#85838f]">{v.status === "verified" ? "live on the map" : "rejected"}</span>
                  </div>
                  {v.status === "verified" && v.myVote === "vouch" ? (
                    <button type="button" disabled={busyId === v.id} onClick={() => act(v.id, "venue", "revoke")} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-[#6f6d78] hover:bg-[#f4f3f7]">
                      <Undo2 className="h-3.5 w-3.5" /> Revoke my vouch
                    </button>
                  ) : null}
                </motion.div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
