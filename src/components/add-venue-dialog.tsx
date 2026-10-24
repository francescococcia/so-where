"use client";

import { FormEvent, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Plus, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LONDON_AREAS } from "@/lib/areas";
import { currentUserId, requestSignIn, takeIntent, useUser } from "@/lib/auth";
import { addVenue } from "@/lib/pending-venues";
import { FancySelect, Stepper } from "@/components/ui/fancy-select";

const AREAS = LONDON_AREAS.map((a) => a.name);

export function AddVenueDialog() {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState<{ name: string; area: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [area, setArea] = useState(AREAS[0]);
  const [capacity, setCapacity] = useState("60");
  const [note, setNote] = useState("");
  const [address, setAddress] = useState("");
  const user = useUser();

  // Resume after sign-in: reopen the form, with anything typed before.
  useEffect(() => {
    if (!user) return;
    const intent = takeIntent("add-venue");
    if (!intent) return;
    const d = intent.draft ?? {};
    if (d.name) setName(d.name);
    if (d.address) setAddress(d.address);
    if (d.area && AREAS.includes(d.area)) setArea(d.area);
    if (d.capacity) setCapacity(d.capacity);
    if (d.note) setNote(d.note);
    setOpen(true);
  }, [user]);

  async function start() {
    if (await currentUserId()) setOpen(true);
    else requestSignIn({ type: "add-venue" });
  }

  function close() {
    setOpen(false);
    setTimeout(() => {
      setSubmitted(null);
      setError(null);
      setName("");
      setNote("");
      setAddress("");
    }, 250);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await addVenue({ name: name.trim(), address: address.trim(), area, capacity: Number(capacity) || null, note: note.trim() });
    setBusy(false);
    if (!res.ok) {
      if (res.signIn) {
        setOpen(false);
        requestSignIn({ type: "add-venue", draft: { name, address, area, capacity, note } });
        return;
      }
      return setError(res.error);
    }
    setSubmitted({ name: name.trim(), area });
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => void start()}
        className="h-10 gap-2 rounded-xl border-[#e8e7ed] px-3.5 font-medium text-[#30303a] shadow-none"
      >
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">Add venue</span>
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[100] grid place-items-center bg-[#20202a]/20 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Add a venue"
              className="w-full max-w-md rounded-3xl border border-[#ecebf0] bg-white p-6 text-[#20202a] shadow-[0_24px_60px_rgba(35,30,65,0.15)]"
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-5 flex items-start justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8473c2]">Suggest a room</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em]">Add a venue</h2>
                </div>
                <button onClick={close} aria-label="Close" className="rounded-lg p-1.5 text-[#85838f] hover:bg-[#f4f3f7]">
                  <X className="h-5 w-5" />
                </button>
              </div>

              {submitted ? (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                  <div className="flex items-start gap-3 rounded-2xl bg-[#f3fbf6] p-4">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#2f9e62]" />
                    <div>
                      <p className="font-medium">{submitted.name} is pending in {submitted.area}</p>
                      <p className="mt-1 text-sm leading-6 text-[#5f6b64]">
                        It stays off the public map until 2 trusted organisers vouch for it.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-2xl bg-[#faf9ff] p-4">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#7854f6]" />
                    <p className="text-sm leading-6 text-[#5f5d6a]">
                      Vouches come from organisers who have hosted there. Everyone sees the same review queue, and each signed-in person can vote once.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[#6f6d78]">
                    <span className="h-2 w-2 rounded-full bg-[#f2b84b]" /> 0 of 2 vouches
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <a href="/review" className="inline-flex h-11 items-center justify-center rounded-xl border border-[#e2dcf7] text-sm font-medium !text-[#5a3fd6] hover:bg-[#faf9ff]">Open review queue</a>
                    <Button onClick={close} className="h-11 rounded-xl bg-[#7854f6] text-white hover:bg-[#6842eb]">Done</Button>
                  </div>
                </motion.div>
              ) : (
                <form onSubmit={submit} className="space-y-4">
                  <label className="block text-sm font-medium">
                    Venue name
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="e.g. Hoxton Community Hall"
                      className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e5ed] px-3 font-normal outline-none focus:border-[#b9a7fb] focus:ring-2 focus:ring-[#7854f6]/10" />
                  </label>
                  <label className="block text-sm font-medium">
                    Street address
                    <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} placeholder="e.g. 133 Bethnal Green Rd, E2 7DG"
                      className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e5ed] px-3 font-normal outline-none focus:border-[#b9a7fb] focus:ring-2 focus:ring-[#7854f6]/10" />
                  </label>
                  <div className="grid gap-3">
                    <div className="block text-sm font-medium">
                      Area
                      <div className="mt-1.5 font-normal"><FancySelect label="Area" value={area} onChange={setArea} options={AREAS.map((a) => ({ value: a, label: a }))} /></div>
                    </div>
                    <div className="block text-sm font-medium">
                      Capacity
                      <div className="mt-1.5 font-normal"><Stepper label="Capacity" value={capacity} onChange={setCapacity} /></div>
                    </div>
                  </div>
                  <label className="block text-sm font-medium">
                    Why it works for organisers
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} placeholder="Free on Thursday evenings, step-free, projector"
                      className="mt-1.5 w-full rounded-xl border border-[#e7e5ed] px-3 py-2 font-normal outline-none focus:border-[#b9a7fb]" />
                  </label>
                  <p className="text-xs leading-5 text-[#92909b]">No personal contact details. New venues need 2 vouches before they go public.</p>
                  {error ? <p role="alert" className="rounded-xl bg-[#fff6f5] px-3 py-2 text-sm text-[#9e4038]">{error}</p> : null}
                  <Button type="submit" disabled={!name.trim() || busy} className="h-11 w-full rounded-xl bg-[#7854f6] text-white hover:bg-[#6842eb]">Submit for vouching</Button>
                </form>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
