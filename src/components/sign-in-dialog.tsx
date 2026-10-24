"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SIGNIN_EVENT } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function friendly(error: { status?: number; message?: string }): string {
  if (error.status === 429 || /rate limit|too many/i.test(error.message ?? "")) {
    return "Too many sign-in emails were sent just now. Please try again in a few minutes.";
  }
  if (/expired|invalid/i.test(error.message ?? "")) return "That code is wrong or has expired. Send a new one.";
  return error.message ?? "Couldn't send the email. Please try again.";
}

/** One shared "Sign in with email to contribute" dialog, opened by requestSignIn(). */
export function SignInDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const show = () => {
      setError("");
      setOpen(true);
    };
    window.addEventListener(SIGNIN_EVENT, show);
    const url = new URL(window.location.href);
    if (url.searchParams.get("signin") === "failed") {
      url.searchParams.delete("signin");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      setError("That sign-in link has expired or was opened in a different browser. Send yourself a new one.");
      setOpen(true);
    }
    return () => window.removeEventListener(SIGNIN_EVENT, show);
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError("");
    const next = window.location.pathname + window.location.search;
    const { error: err } = await getSupabase().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`, shouldCreateUser: true },
    });
    setBusy(false);
    if (err) setError(friendly(err));
    else setSent(true);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: err } = await getSupabase().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (err) setError(friendly(err));
    else {
      setOpen(false);
      setSent(false);
      setCode("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#f1edff] text-[#7854f6]">
            <Mail className="h-5 w-5" />
          </span>
          <DialogTitle>Sign in with email to contribute</DialogTitle>
          <DialogDescription>
            Browsing Lumap is open to everyone. To add venues, host sessions or vouch, sign in with your email, no password needed. Your email is never shown to other people.
          </DialogDescription>
        </DialogHeader>

        {!sent ? (
          <form onSubmit={send} className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium text-[#45434e]">
              Email
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-11 rounded-xl border border-[#e8e7ed] bg-white px-3.5 text-[15px] font-normal text-[#20202a] outline-none placeholder:text-[#a8a6b0] focus:border-[#7854f6] focus:ring-2 focus:ring-[#7854f6]/20"
              />
            </label>
            <Button type="submit" disabled={busy} className="h-11 rounded-xl">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Email me a sign-in link
            </Button>
          </form>
        ) : (
          <div className="grid gap-3">
            <p className="rounded-xl bg-[#f6f4ff] px-4 py-3 text-sm leading-6 text-[#45434e]" role="status">
              Check your inbox at <span className="font-medium text-[#20202a]">{email.trim()}</span>. Open the link in this browser and you&apos;ll come straight back to what you were doing.
            </p>
            <form onSubmit={verify} className="grid gap-2">
              <label className="grid gap-1.5 text-sm font-medium text-[#45434e]">
                Or type the 6-digit code from the email
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,10}"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="h-11 rounded-xl border border-[#e8e7ed] bg-white px-3.5 text-[15px] tracking-[0.3em] text-[#20202a] outline-none focus:border-[#7854f6] focus:ring-2 focus:ring-[#7854f6]/20"
                />
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || code.length < 6} className="h-10 flex-1 rounded-xl">
                  Sign in with code
                </Button>
                <Button type="button" variant="outline" className="h-10 rounded-xl" onClick={() => { setSent(false); setCode(""); setError(""); }}>
                  Use another email
                </Button>
              </div>
            </form>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-[#9e4038]">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
