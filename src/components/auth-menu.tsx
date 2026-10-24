"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { requestSignIn, signOut, useUser } from "@/lib/auth";

/** Header control: "Sign in" when signed out, an avatar with the email and Sign out when signed in. */
export function AuthMenu() {
  const user = useUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (user === undefined) return <span className="h-10 w-10" aria-hidden />;

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => requestSignIn()}
        className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-medium text-[#484751] transition-colors hover:bg-[#f4f3f7] hover:text-[#7854f6]"
      >
        Sign in
      </button>
    );
  }

  const email = user.email ?? "Signed in";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Account menu for ${email}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#f1edff] text-sm font-semibold uppercase text-[#7854f6] ring-1 ring-[#e3dcff] transition-colors hover:bg-[#e8e1ff]"
      >
        {email.charAt(0)}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-12 z-[70] w-64 rounded-xl border border-[#ecebf0] bg-white p-2 shadow-[0_16px_40px_rgba(32,32,42,0.14)]">
          <p className="truncate px-3 py-2 text-sm text-[#45434e]" title={email}>
            {email}
          </p>
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOut();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-[#45434e] hover:bg-[#f4f3f7]"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
