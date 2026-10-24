// So where? mark: two people (dots) joined by a route, the fair middle highlighted.
export function Mark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--sw-ink)" />
      <path d="M7 21 C 11 21, 12 11, 16 11 S 21 21, 25 21" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeDasharray="0.1 4" />
      <circle cx="7" cy="21" r="2.6" fill="#fff" />
      <circle cx="25" cy="21" r="2.6" fill="var(--sw-signal)" />
      <circle cx="16" cy="11" r="4" fill="var(--sw-hi)" />
    </svg>
  );
}
