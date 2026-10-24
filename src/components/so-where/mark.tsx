// So where? mark: two people (dots) joined by a route, the fair middle highlighted.
export function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} style={{ filter: "drop-shadow(0 2px 4px rgba(74,52,30,.16))" }} aria-hidden>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="#fff" stroke="var(--sw-border)" />
      <path d="M7 21 C 11 21, 12 11, 16 11 S 21 21, 25 21" fill="none" stroke="var(--sw-ink-3)" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.1 4" />
      <circle cx="7" cy="21" r="2.8" fill="var(--sw-sky)" />
      <circle cx="25" cy="21" r="2.8" fill="var(--sw-signal)" />
      <circle cx="16" cy="11" r="4.2" fill="var(--sw-hi)" stroke="#c79a00" strokeWidth="0.8" />
    </svg>
  );
}
