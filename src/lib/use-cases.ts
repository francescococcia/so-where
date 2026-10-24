// What the organiser is planning. Each use case sets sensible defaults
// and says which kinds of venue suit it best.

export type VenueKind = "community" | "office" | "cafe" | "bar" | "studio" | "campus" | "outdoor" | "venue";

export const KIND_LABEL: Record<VenueKind, string> = {
  community: "Community space",
  office: "Office / tech space",
  cafe: "Café",
  bar: "Bar, hotel or private room",
  studio: "Studio / loft",
  campus: "Campus or library",
  outdoor: "Outdoor",
  venue: "Venue",
};

// The database has no venue type column yet, so the kind is read from the
// name, notes and terms. Order matters: the first match wins.
const RULES: [VenueKind, RegExp][] = [
  ["outdoor", /\b(park|garden|square|common|heath)\b/i],
  ["cafe", /(caf[eé]|coffee|matcha|bakery|tea room|laundre)/i],
  ["bar", /(\bbar\b|\bpub\b|lounge|tavern|restaurant|hotel|otel\b|\bgrace\b|drapers|solt room|private room|\bclub\b)/i],
  ["campus", /(college|universit|saint martins|school|librar|bookshop|libreria|building centre)/i],
  ["studio", /(studio|loft|gallery|pocko|arro\b|workshop)/i],
  ["community", /(community|\bhall\b|church|centre|center|newspeak|house)/i],
  ["office", /(payments|\bmeta\b|granola|autogen|harvey nash|qube|works|cowork|office|\d+\s.*\b(rd|road|st|street)\b)/i],
];

export function venueKind(v: { name?: string | null; notes?: string | null; terms?: string | null }): VenueKind {
  const text = [v.name, v.notes, v.terms].filter(Boolean).join(" ").replace(/^EXAMPLE · /, "");
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return "venue";
}

export type UseCaseId = "meetup" | "cowork" | "party" | "workshop";

export type UseCase = {
  id: UseCaseId;
  label: string;
  short: string;
  day: string;
  start: string;
  end: string;
  capacity: string;
  kinds: VenueKind[];
  tip: string;
  empty: string;
};

export const USE_CASES: UseCase[] = [
  {
    id: "meetup",
    label: "Community event",
    short: "Meetup",
    day: "thu",
    start: "19:00",
    end: "22:00",
    capacity: "80",
    kinds: ["community", "office", "campus", "studio"],
    tip: "Community rooms and tech offices that have hosted meetups come first.",
    empty: "No room is free for that evening yet. Try another weeknight, a nearby area, or Anywhere.",
  },
  {
    id: "cowork",
    label: "Cowork with others",
    short: "Coworking",
    day: "tue",
    start: "09:00",
    end: "17:00",
    capacity: "4",
    kinds: ["cafe", "office", "campus"],
    tip: "Weekly sessions where founders and builders work side by side, plus cafés and offices open all day.",
    empty: "No daytime spot fits yet. Try a shorter day, a smaller group, or Anywhere.",
  },
  {
    id: "party",
    label: "Private party",
    short: "Birthday",
    day: "sat",
    start: "19:00",
    end: "23:00",
    capacity: "30",
    kinds: ["bar", "studio", "venue"],
    tip: "Bars, hotels and private rooms that stay open late come first.",
    empty: "Nothing confirmed open that late yet. Try an earlier finish, Friday, or Anywhere.",
  },
  {
    id: "workshop",
    label: "Workshop",
    short: "Workshop",
    day: "sat",
    start: "10:00",
    end: "16:00",
    capacity: "25",
    kinds: ["studio", "community", "campus", "office"],
    tip: "Studios and community rooms with space to spread out come first.",
    empty: "No room fits that daytime slot yet. Try Sunday, a smaller group, or Anywhere.",
  },
];

export function kindScore(kind: VenueKind, useCase: UseCase) {
  const i = useCase.kinds.indexOf(kind);
  return i < 0 ? 0 : useCase.kinds.length - i;
}
