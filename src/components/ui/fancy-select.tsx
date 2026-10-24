"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";

export type FancyOption = { value: string; label: string };

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: FancyOption[];
  label?: string;
  icon?: React.ReactNode;
  className?: string;
};

export function FancySelect({ value, onChange, options, label, icon, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setRect({ top: r.bottom + 8, left: r.left, width: r.width });
    };
    place();
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, options, value]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") return setOpen(false);
    if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      return setOpen(true);
    }
    if (!open) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onChange(options[active].value);
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={`flex h-11 w-full items-center gap-2 rounded-xl border bg-white px-3 text-left text-sm font-medium text-[#20202a] shadow-[0_1px_2px_rgba(32,32,42,0.04)] transition-all hover:border-[#cfc4fb] ${open ? "border-[#b9a7fb] ring-4 ring-[#7854f6]/10" : "border-[#e8e7ed]"}`}
      >
        {icon ? <span className="text-[#7854f6]">{icon}</span> : null}
        <span className="flex-1 truncate">{current?.label}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="text-[#85838f]">
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </button>
      {typeof document !== "undefined" ? createPortal(
      <AnimatePresence>
        {open && rect ? (
          <motion.ul
            ref={listRef}
            role="listbox"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            style={rect ? { position: "fixed", top: rect.top, left: rect.left, width: rect.width } : undefined}
            className="z-[200] max-h-64 origin-top overflow-auto rounded-2xl border border-[#ecebf0] bg-white p-1.5 shadow-[0_16px_40px_rgba(35,30,65,0.14)]"
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              return (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => { onChange(option.value); setOpen(false); }}
                  className={`flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors ${index === active ? "bg-[#f4f0ff] text-[#5a3fd6]" : "text-[#30303a]"} ${selected ? "font-semibold" : ""}`}
                >
                  {option.label}
                  {selected ? <Check className="h-4 w-4 text-[#7854f6]" /> : null}
                </li>
              );
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>,
        document.body,
      ) : null}
    </div>
  );
}

export function Stepper({ value, onChange, step = 10, min = 0, label }: { value: string; onChange: (v: string) => void; step?: number; min?: number; label?: string }) {
  const n = Number(value) || 0;
  const btn = "grid h-9 w-9 place-items-center rounded-lg text-lg font-medium text-[#5a3fd6] transition-colors hover:bg-[#f4f0ff] active:scale-95";
  return (
    <div className="flex h-11 items-center gap-1 rounded-xl border border-[#e8e7ed] bg-white px-1 shadow-[0_1px_2px_rgba(32,32,42,0.04)] focus-within:border-[#b9a7fb] focus-within:ring-4 focus-within:ring-[#7854f6]/10">
      <button type="button" aria-label="Decrease" className={btn} onClick={() => onChange(String(Math.max(min, n - step)))}>−</button>
      <input
        aria-label={label}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))}
        className="h-full w-full bg-transparent text-center text-sm font-semibold text-[#20202a] outline-none"
      />
      <span className="pr-1 text-xs text-[#92909b]">people</span>
      <button type="button" aria-label="Increase" className={btn} onClick={() => onChange(String(n + step))}>+</button>
    </div>
  );
}
