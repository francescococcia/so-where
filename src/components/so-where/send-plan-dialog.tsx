"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Lock, X } from "lucide-react";

/** Draft only. Nothing in here sends anything; the user copies and sends it themselves. */
export function SendPlanDialog({ open, onOpenChange, draft }: { open: boolean; onOpenChange: (o: boolean) => void; draft: string }) {
  const [text, setText] = useState(draft);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open) {
      setText(draft);
      setCopied(false);
    }
  }, [open, draft]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.getElementById("sw-draft") as HTMLTextAreaElement | null;
      ta?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-[90] bg-ink/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content forceMount aria-describedby="sw-draft-note" className="fixed inset-0 z-[91] flex items-end justify-center p-4 sm:items-center" onPointerDown={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}>
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.98 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="w-full max-w-[460px] rounded-[20px] bg-surface p-5 shadow-[var(--sw-shadow-float)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <Dialog.Title className="text-[20px] font-semibold tracking-[-0.01em]">Send plan</Dialog.Title>
                  <Dialog.Close className="-m-2 grid size-11 cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-raised hover:text-ink" aria-label="Close">
                    <X className="size-5" aria-hidden />
                  </Dialog.Close>
                </div>
                <p id="sw-draft-note" className="mt-1 flex items-start gap-1.5 text-[13px] leading-5 text-ink-3">
                  <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Nothing is sent from here. Copy it and send it yourself. Their area isn&apos;t in the message.
                </p>
                <label htmlFor="sw-draft" className="sr-only">Message draft</label>
                <textarea
                  id="sw-draft"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  className="mt-4 w-full resize-none rounded-[14px] border border-line bg-raised p-3.5 text-[16px] leading-6 text-ink focus:border-ink focus:outline-none"
                />
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close className="min-h-11 cursor-pointer rounded-[10px] px-4 text-[15px] font-medium text-ink-2 hover:text-ink">Close</Dialog.Close>
                  <motion.button type="button" onClick={copy} whileTap={{ scale: 0.97 }} className="inline-flex min-h-11 min-w-[132px] cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-ink px-4 text-[15px] font-semibold text-white">
                    <AnimatePresence mode="popLayout" initial={false}>
                      {copied ? (
                        <motion.span key="ok" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="inline-flex items-center gap-2">
                          <Check className="size-4" aria-hidden /> Copied
                        </motion.span>
                      ) : (
                        <motion.span key="copy" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="inline-flex items-center gap-2">
                          <Copy className="size-4" aria-hidden /> Copy text
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.button>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
