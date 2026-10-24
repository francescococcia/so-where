"use client";

// "Organiser details" for one venue: price, access, toilets, AV, wifi, capacity, latest finish and a
// private booking contact, aggregated from organisers who hosted there (venue_details view), with
// facts from the venue's own website shown separately. Vouching and sharing need a signed-in account.

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Globe, Lock, PencilLine, ShieldCheck, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getSupabase } from "@/lib/supabase";
import { requestSignIn, useUser, type Intent } from "@/lib/auth";

type VenueRef = Extract<Intent, { type: "venue-report" }>["venue"];

type DetailRow = { field: string; source: "organiser" | "public_source"; value: unknown; confirmations: number; reports: number; last_updated: string; source_url: string | null };
type Report = {
  id: string;
  hosted_here: boolean;
  price_kind: string | null;
  price_min: number | null;
  price_max: number | null;
  price_note: string | null;
  step_free: string | null;
  accessible_toilet: boolean | null;
  toilets_count: number | null;
  projector: boolean | null;
  microphones: boolean | null;
  wifi: boolean | null;
  guest_wifi_ok: boolean | null;
  capacity_seated: number | null;
  capacity_standing: number | null;
  latest_finish: string | null;
};
type Contact = { report_id: string; kind: "email" | "form" | "role"; value: string; author: string | null };

export const REPORT_CHANGED = "lumap:venue-report-changed";

const yesNo = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : String(v));
const STEP_FREE: Record<string, string> = { yes: "Yes, step-free", partial: "Partly (some steps or a lift with limits)", no: "No, steps only" };
function priceText(v: unknown) {
  const p = v as { kind?: string; min?: number; max?: number };
  if (!p?.kind) return "";
  if (p.kind === "free") return "Free";
  if (p.kind === "sponsored") return "Free if sponsored / hosted by a member";
  const range = p.min != null && p.max != null && p.max !== p.min ? `£${p.min}–£${p.max}` : p.min != null ? `From £${p.min}` : p.max != null ? `up to £${p.max}` : "";
  if (p.kind === "minimum_spend") return `Minimum spend${range ? ` ${range.replace("From", "from")}` : ""}`;
  return range || "Paid";
}

type FieldDef = { key: string; label: string; show: (v: unknown, all: Record<string, unknown>) => string; extra?: string[] };
const FIELDS: FieldDef[] = [
  { key: "price", label: "Price per evening", show: priceText, extra: ["price_note"] },
  { key: "step_free", label: "Step-free access", show: (v) => STEP_FREE[String(v)] ?? String(v) },
  { key: "accessible_toilet", label: "Accessible toilet", show: yesNo, extra: ["toilets_count"] },
  { key: "projector", label: "Projector or screen", show: yesNo },
  { key: "microphones", label: "Microphones / PA", show: yesNo },
  { key: "wifi", label: "Wifi", show: yesNo, extra: ["guest_wifi_ok"] },
  { key: "capacity_standing", label: "Max capacity", show: (v) => `${v} standing`, extra: ["capacity_seated"] },
  { key: "latest_finish", label: "Latest finish", show: (v) => String(v) },
];
const EXTRA_TEXT: Record<string, (v: unknown) => string> = {
  price_note: (v) => String(v),
  toilets_count: (v) => `${v} toilets in total`,
  guest_wifi_ok: (v) => (v ? "Guest wifi is fine for attendees" : "No guest wifi for attendees"),
  capacity_seated: (v) => `${v} seated`,
};
// A field counts as known if its main value or (for capacity) the seated figure is known.
const ALIASES: Record<string, string[]> = { price: ["price_note"], capacity_standing: ["capacity_seated"], accessible_toilet: ["toilets_count"] };

const shortDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

export function OrganiserDetails({ venue, autoAction, onAutoActionDone }: { venue: VenueRef; autoAction?: "vouch" | "report" | null; onAutoActionDone?: () => void }) {
  const user = useUser();
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [mine, setMine] = useState<Report | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [canSee, setCanSee] = useState(false);
  // Which user the current rows were loaded for (null = signed out), so resuming waits for the signed-in load.
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justVouched, setJustVouched] = useState(false);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const { data } = await sb.from("venue_details").select("field, source, value, confirmations, reports, last_updated, source_url").eq("venue_id", venue.id);
    setRows((data ?? []) as DetailRow[]);
    if (user) {
      const [{ data: own }, { data: cs }, { data: can }] = await Promise.all([
        sb.from("venue_reports").select("*").eq("venue_id", venue.id).eq("author", user.id).maybeSingle(),
        sb.from("venue_report_contacts").select("report_id, kind, value, author").eq("venue_id", venue.id),
        sb.rpc("can_see_booking_contacts"),
      ]);
      setMine((own as Report | null) ?? null);
      setContacts((cs ?? []) as Contact[]);
      setCanSee(Boolean(can));
    } else {
      setMine(null);
      setContacts([]);
      setCanSee(false);
    }
    setLoadedFor(user?.id ?? null);
  }, [venue.id, user]);

  useEffect(() => {
    if (user === undefined) return;
    void load();
    const again = () => void load();
    window.addEventListener(REPORT_CHANGED, again);
    return () => window.removeEventListener(REPORT_CHANGED, again);
  }, [load, user]);

  async function vouch() {
    if (!user) return requestSignIn({ type: "venue-report", action: "vouch", venue });
    setBusy(true);
    setError(null);
    const sb = getSupabase();
    const res = mine
      ? await sb.from("venue_reports").update({ hosted_here: true }).eq("id", mine.id)
      : await sb.from("venue_reports").insert({ venue_id: venue.id, hosted_here: true });
    setBusy(false);
    if (res.error) return setError(res.error.message);
    setJustVouched(true);
    window.dispatchEvent(new CustomEvent(REPORT_CHANGED));
    setFormOpen(true);
  }

  async function withdraw() {
    if (!mine) return;
    if (!window.confirm("Withdraw your vouch and the details you shared for this venue?")) return;
    const { error: e } = await getSupabase().from("venue_reports").delete().eq("id", mine.id);
    if (e) return setError(e.message);
    setJustVouched(false);
    window.dispatchEvent(new CustomEvent(REPORT_CHANGED));
  }

  function share() {
    if (!user) return requestSignIn({ type: "venue-report", action: "report", venue });
    setFormOpen(true);
  }

  // Resume what was started before signing in.
  useEffect(() => {
    // The session can briefly read as signed out right after the sign-in redirect, so only resume
    // (and consume the intent) once the signed-in user's own data has loaded.
    if (!autoAction || !user || loadedFor !== user.id) return;
    onAutoActionDone?.();
    if (autoAction === "vouch") void vouch();
    else setFormOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAction, user, loadedFor]);

  const org = (k: string) => rows.find((r) => r.field === k && r.source === "organiser");
  const pub = (k: string) => rows.find((r) => r.field === k && r.source === "public_source");
  const hosted = org("hosted_here");
  const contactKnown = Boolean(org("booking_contact") || pub("booking_contact"));
  const known = FIELDS.filter((f) => [f.key, ...(ALIASES[f.key] ?? [])].some((k) => org(k) || pub(k))).length;
  const vouchedByMe = Boolean(mine?.hosted_here);

  return (
    <div className="rounded-2xl border border-[#ecebf0] p-4" data-testid="organiser-details">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[#8473c2]">
          <ShieldCheck className="h-3.5 w-3.5" /> Organiser details
        </p>
        <span className="text-[11px] text-[#8a8894]">{known + (contactKnown ? 1 : 0)} of {FIELDS.length + 1} known</span>
      </div>
      <p className="mb-3 text-xs text-[#6f6d78]">
        {hosted ? `${hosted.confirmations} ${hosted.confirmations === 1 ? "organiser has" : "organisers have"} hosted here and vouched.` : "No organiser has vouched for hosting here yet."}
      </p>
      <dl className="grid gap-2.5">
        {FIELDS.map((f) => {
          const o = org(f.key) ?? (ALIASES[f.key] ?? []).map(org).find(Boolean);
          const p = pub(f.key) ?? (ALIASES[f.key] ?? []).map(pub).find(Boolean);
          const src = o ? "organiser" : p ? "public_source" : null;
          const value = (k: string) => rows.find((r) => r.field === k && r.source === src)?.value;
          const main = src && value(f.key) != null ? f.show(value(f.key), {}) : null;
          const extras = (f.extra ?? []).map((k) => (src && value(k) != null ? EXTRA_TEXT[k](value(k)) : null)).filter(Boolean) as string[];
          return (
            <div key={f.key} className="grid gap-0.5">
              <dt className="text-xs font-medium text-[#8a8894]">{f.label}</dt>
              {src ? (
                <dd className="text-sm text-[#30303a]">
                  <span className="font-semibold">{[main, ...extras].filter(Boolean).join(" · ")}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#8a8894]">
                    {o ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#e6f7ef] px-1.5 py-px font-semibold text-[#1f7a52]">
                        <CheckCircle2 className="h-3 w-3" /> Confirmed by {o.confirmations} {o.confirmations === 1 ? "organiser" : "organisers"}
                      </span>
                    ) : null}
                    {o ? <span>updated {shortDate(o.last_updated)}</span> : null}
                    {!o && p ? <PublicBadge url={p.source_url} date={p.last_updated} /> : null}
                  </span>
                </dd>
              ) : (
                <dd className="text-sm text-[#9a6412]">
                  Not known yet –{" "}
                  <button type="button" onClick={share} className="font-semibold text-[#7854f6] hover:underline">
                    hosted here? Add it
                  </button>
                </dd>
              )}
            </div>
          );
        })}
        <div className="grid gap-0.5">
          <dt className="flex items-center gap-1 text-xs font-medium text-[#8a8894]"><Lock className="h-3 w-3" /> Booking contact</dt>
          {contacts.length && (canSee || contacts.every((c) => c.author === user?.id)) ? (
            <dd className="grid gap-1 text-sm text-[#30303a]">
              {contacts.map((c) => (
                <span key={c.report_id} className="font-semibold">
                  {c.kind === "email" ? <a className="!text-[#5a3fd6] hover:underline" href={`mailto:${c.value}`}>{c.value}</a> : c.kind === "form" ? <a className="!text-[#5a3fd6] hover:underline" href={c.value} target="_blank" rel="noopener noreferrer">Booking form <ExternalLink className="inline h-3 w-3" /></a> : c.value}
                  <span className="ml-1.5 text-[11px] font-normal text-[#8a8894]">{c.author === user?.id ? "shared by you" : c.author ? "from an organiser" : "venue's website"} · private</span>
                </span>
              ))}
            </dd>
          ) : contactKnown ? (
            <dd className="text-sm text-[#5f5640]">
              Visible to vouched organisers –{" "}
              {user ? (
                <a href="/review" className="font-semibold !text-[#7854f6] hover:underline">get vouched</a>
              ) : (
                <button type="button" onClick={() => requestSignIn()} className="font-semibold text-[#7854f6] hover:underline">sign in</button>
              )}
              {user ? <span className="block text-[11px] text-[#8a8894]">Add a venue or session that two other organisers vouch for, or get vouched by an organiser.</span> : <span> / get vouched</span>}
            </dd>
          ) : (
            <dd className="text-sm text-[#9a6412]">
              Not known yet –{" "}
              <button type="button" onClick={share} className="font-semibold text-[#7854f6] hover:underline">hosted here? Add it</button>
              <span className="block text-[11px] text-[#8a8894]">Shared only with vouched organisers.</span>
            </dd>
          )}
        </div>
      </dl>
      {error ? <p className="mt-3 rounded-xl bg-[#fff4f4] px-3 py-2 text-xs text-[#9b2c2c]">{error}</p> : null}
      <div className="mt-4 grid gap-2">
        {vouchedByMe ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-[#e6f7ef] px-3 py-2.5 text-sm font-medium text-[#1f7a52]">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> {justVouched ? "Thanks, you vouched for this venue" : "You vouched: you've hosted here"}</span>
            <button type="button" onClick={() => void withdraw()} className="text-xs font-semibold text-[#1f7a52] underline-offset-2 hover:underline">Withdraw</button>
          </div>
        ) : (
          <button type="button" disabled={busy} onClick={() => void vouch()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#7854f6] text-sm font-semibold text-white transition-colors hover:bg-[#6842eb] disabled:opacity-60">
            <ShieldCheck className="h-4 w-4" /> {user ? "Vouch, I've hosted here" : "Sign in to vouch: I've hosted here"}
          </button>
        )}
        <button type="button" onClick={share} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[#e8e7ed] bg-white text-sm font-medium text-[#30303a] transition-colors hover:bg-[#faf9ff]">
          <PencilLine className="h-4 w-4 text-[#7854f6]" /> {mine ? "Edit what you shared" : user ? "Hosted here? Share what it's like" : "Sign in to share what it's like"}
        </button>
      </div>
      {user ? (
        <ReportForm
          open={formOpen}
          onOpenChange={setFormOpen}
          venue={venue}
          mine={mine}
          myContact={contacts.find((c) => c.author === user.id && c.report_id === mine?.id) ?? null}
          afterVouch={justVouched}
        />
      ) : null}
    </div>
  );
}

function PublicBadge({ url, date }: { url: string | null; date: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-full bg-[#eef4ff] px-1.5 py-px font-semibold text-[#2b59c3]">
        <Globe className="h-3 w-3" /> From the venue&apos;s website
      </span>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="!text-[#2b59c3] hover:underline">
          {new URL(url).hostname.replace(/^www\./, "")}
        </a>
      ) : null}
      <span>checked {shortDate(date)}</span>
    </span>
  );
}

const input = "mt-1 h-10 w-full rounded-xl border border-[#e7e5ed] bg-white px-3 text-sm font-normal text-[#20202a] outline-none focus:border-[#b9a7fb] focus:ring-2 focus:ring-[#7854f6]/10";

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; t: string }[] }) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-xs font-medium text-[#484751]">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {[{ v: "", t: "Not sure" }, ...options].map((o) => (
          <button
            key={o.v || "unknown"}
            type="button"
            aria-pressed={value === o.v}
            onClick={() => onChange(o.v)}
            className={`h-8 rounded-full px-3 text-xs font-semibold transition-colors ${value === o.v ? (o.v ? "bg-[#7854f6] text-white" : "bg-[#30303a] text-white") : "bg-[#f4f3f8] text-[#5f5d68] hover:bg-[#ebe8f5]"}`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const YN = [{ v: "yes", t: "Yes" }, { v: "no", t: "No" }];
const b2s = (b: boolean | null | undefined) => (b === true ? "yes" : b === false ? "no" : "");
const s2b = (s: string) => (s === "yes" ? true : s === "no" ? false : null);
const n2s = (n: number | null | undefined) => (n == null ? "" : String(n));
const s2n = (s: string) => (s.trim() === "" ? null : Number(s));

function ReportForm({ open, onOpenChange, venue, mine, myContact, afterVouch }: { open: boolean; onOpenChange: (o: boolean) => void; venue: VenueRef; mine: Report | null; myContact: Contact | null; afterVouch: boolean }) {
  const blank = () => ({
    hosted_here: mine?.hosted_here ?? true,
    price_kind: mine?.price_kind ?? "",
    price_min: n2s(mine?.price_min),
    price_max: n2s(mine?.price_max),
    price_note: mine?.price_note ?? "",
    step_free: mine?.step_free ?? "",
    accessible_toilet: b2s(mine?.accessible_toilet),
    toilets_count: n2s(mine?.toilets_count),
    projector: b2s(mine?.projector),
    microphones: b2s(mine?.microphones),
    wifi: b2s(mine?.wifi),
    guest_wifi_ok: b2s(mine?.guest_wifi_ok),
    capacity_seated: n2s(mine?.capacity_seated),
    capacity_standing: n2s(mine?.capacity_standing),
    latest_finish: mine?.latest_finish?.slice(0, 5) ?? "",
    contact_kind: (myContact?.kind ?? "email") as Contact["kind"],
    contact_value: myContact?.value ?? "",
  });
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (open) {
      setF(blank());
      setError(null);
      setSaved(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof ReturnType<typeof blank>) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const contact = f.contact_value.trim();
    if (contact && /\+?\d[\d\s().-]{7,}\d/.test(contact)) return setError("Please don't share phone numbers. Use a booking email, an enquiry form link or a role (e.g. 'events team').");
    if (contact && f.contact_kind === "email" && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(contact)) return setError("That booking email doesn't look right.");
    if (contact && f.contact_kind === "form" && !/^https?:\/\//.test(contact)) return setError("The booking form needs to be a link starting with https://");
    const nums = [f.price_min, f.price_max, f.toilets_count, f.capacity_seated, f.capacity_standing].filter((x) => x.trim());
    if (nums.some((x) => !/^\d+$/.test(x.trim()))) return setError("Prices, toilets and capacity need to be whole numbers.");
    const row = {
      hosted_here: f.hosted_here,
      price_kind: f.price_kind || null,
      price_min: f.price_kind === "paid" || f.price_kind === "minimum_spend" ? s2n(f.price_min) : null,
      price_max: f.price_kind === "paid" || f.price_kind === "minimum_spend" ? s2n(f.price_max) : null,
      price_note: f.price_note.trim() || null,
      step_free: f.step_free || null,
      accessible_toilet: s2b(f.accessible_toilet),
      toilets_count: s2n(f.toilets_count),
      projector: s2b(f.projector),
      microphones: s2b(f.microphones),
      wifi: s2b(f.wifi),
      guest_wifi_ok: f.wifi === "yes" ? s2b(f.guest_wifi_ok) : null,
      capacity_seated: s2n(f.capacity_seated),
      capacity_standing: s2n(f.capacity_standing),
      latest_finish: f.latest_finish || null,
    };
    setBusy(true);
    const sb = getSupabase();
    let reportId = mine?.id;
    if (mine) {
      const { error: err } = await sb.from("venue_reports").update(row).eq("id", mine.id);
      if (err) return (setBusy(false), setError(err.message));
    } else {
      const { data, error: err } = await sb.from("venue_reports").insert({ venue_id: venue.id, ...row }).select("id").single();
      if (err) return (setBusy(false), setError(err.message));
      reportId = (data as { id: string }).id;
    }
    if (contact) {
      const { error: err } = myContact
        ? await sb.from("venue_report_contacts").update({ kind: f.contact_kind, value: contact }).eq("report_id", reportId!)
        : await sb.from("venue_report_contacts").insert({ report_id: reportId!, venue_id: venue.id, kind: f.contact_kind, value: contact });
      if (err) return (setBusy(false), setError(err.message.includes("no_phone") ? "Please don't share phone numbers." : err.message));
    } else if (myContact) {
      await sb.from("venue_report_contacts").delete().eq("report_id", reportId!);
    }
    setBusy(false);
    setSaved(true);
    window.dispatchEvent(new CustomEvent(REPORT_CHANGED));
    setTimeout(() => onOpenChange(false), 900);
  }

  const paid = f.price_kind === "paid" || f.price_kind === "minimum_spend";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-lg overflow-y-auto" aria-describedby="report-desc">
        <DialogHeader>
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[#8473c2]"><Sparkles className="h-3.5 w-3.5" /> {afterVouch ? "Thanks for vouching" : "Hosted here?"}</p>
          <DialogTitle>Share what {venue.name} is like</DialogTitle>
          <DialogDescription id="report-desc">Only what you know from hosting there. Leave anything you&apos;re unsure about as &quot;Not sure&quot;. You can update it later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4 text-sm">
          <fieldset className="grid gap-2 rounded-2xl bg-[#faf9ff] p-3">
            <Choice label="Price per evening" value={f.price_kind} onChange={set("price_kind")} options={[{ v: "free", t: "Free" }, { v: "sponsored", t: "Free if sponsored" }, { v: "paid", t: "Hire fee" }, { v: "minimum_spend", t: "Minimum spend" }]} />
            {paid ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-medium text-[#484751]">From £<input inputMode="numeric" aria-label="Price from (£)" className={input} value={f.price_min} onChange={(e) => set("price_min")(e.target.value)} /></label>
                <label className="text-xs font-medium text-[#484751]">To £ (optional)<input inputMode="numeric" aria-label="Price to (£)" className={input} value={f.price_max} onChange={(e) => set("price_max")(e.target.value)} /></label>
              </div>
            ) : null}
            <label className="text-xs font-medium text-[#484751]">What&apos;s included (optional)<input aria-label="What's included" maxLength={300} placeholder="e.g. AV and a staff member, drinks extra" className={input} value={f.price_note} onChange={(e) => set("price_note")(e.target.value)} /></label>
          </fieldset>
          <fieldset className="grid gap-2 rounded-2xl bg-[#faf9ff] p-3">
            <Choice label="Step-free access" value={f.step_free} onChange={set("step_free")} options={[{ v: "yes", t: "Yes" }, { v: "partial", t: "Partly" }, { v: "no", t: "No" }]} />
            <Choice label="Accessible toilet" value={f.accessible_toilet} onChange={set("accessible_toilet")} options={YN} />
            <label className="text-xs font-medium text-[#484751]">Number of toilets (optional)<input inputMode="numeric" aria-label="Number of toilets" className={input} value={f.toilets_count} onChange={(e) => set("toilets_count")(e.target.value)} /></label>
          </fieldset>
          <fieldset className="grid gap-2 rounded-2xl bg-[#faf9ff] p-3">
            <Choice label="Projector or screen" value={f.projector} onChange={set("projector")} options={YN} />
            <Choice label="Microphones / PA" value={f.microphones} onChange={set("microphones")} options={YN} />
            <Choice label="Wifi" value={f.wifi} onChange={set("wifi")} options={YN} />
            {f.wifi === "yes" ? <Choice label="Fine for attendees to use (guest wifi)?" value={f.guest_wifi_ok} onChange={set("guest_wifi_ok")} options={YN} /> : null}
          </fieldset>
          <fieldset className="grid grid-cols-3 gap-2 rounded-2xl bg-[#faf9ff] p-3">
            <label className="text-xs font-medium text-[#484751]">Seated<input inputMode="numeric" aria-label="Max seated" className={input} value={f.capacity_seated} onChange={(e) => set("capacity_seated")(e.target.value)} /></label>
            <label className="text-xs font-medium text-[#484751]">Standing<input inputMode="numeric" aria-label="Max standing" className={input} value={f.capacity_standing} onChange={(e) => set("capacity_standing")(e.target.value)} /></label>
            <label className="text-xs font-medium text-[#484751]">Latest finish<input type="time" aria-label="Latest finish" className={input} value={f.latest_finish} onChange={(e) => set("latest_finish")(e.target.value)} /></label>
          </fieldset>
          <fieldset className="grid gap-2 rounded-2xl border border-[#f3e3c3] bg-[#fffaf0] p-3">
            <legend className="sr-only">Booking contact</legend>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#6b4a0c]"><Lock className="h-3.5 w-3.5" /> Booking contact · private, shown only to vouched organisers</p>
            <div className="flex flex-wrap gap-1.5">
              {([{ v: "email", t: "Booking email" }, { v: "form", t: "Enquiry form link" }, { v: "role", t: "Who to ask" }] as const).map((o) => (
                <button key={o.v} type="button" aria-pressed={f.contact_kind === o.v} onClick={() => set("contact_kind")(o.v)} className={`h-8 rounded-full px-3 text-xs font-semibold ${f.contact_kind === o.v ? "bg-[#6b4a0c] text-white" : "bg-white text-[#6b4a0c] ring-1 ring-[#ecd7ad]"}`}>{o.t}</button>
              ))}
            </div>
            <input aria-label="Booking contact" maxLength={200} className={input} value={f.contact_value} onChange={(e) => set("contact_value")(e.target.value)} placeholder={f.contact_kind === "email" ? "events@venue.co.uk" : f.contact_kind === "form" ? "https://venue.co.uk/hire" : "e.g. Events team, ask at the bar"} />
            <p className="text-[11px] text-[#8a7a55]">A venue&apos;s general booking email, form or role. No personal phone numbers or private emails.</p>
          </fieldset>
          {error ? <p className="rounded-xl bg-[#fff4f4] px-3 py-2 text-xs text-[#9b2c2c]">{error}</p> : null}
          <button type="submit" disabled={busy || saved} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#7854f6] text-sm font-semibold text-white hover:bg-[#6842eb] disabled:opacity-70">
            {saved ? <><CheckCircle2 className="h-4 w-4" /> Saved, thank you</> : busy ? "Saving…" : "Save details"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
