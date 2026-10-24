// Turns "next week", "on Saturday", "tomorrow" or "30 Oct" in a question into a London date range.

import { addDays, dateLabel, londonToday, nextWeekday, weekdayOf } from "@/lib/dates";
import { WEEK, type DayKey } from "@/lib/hours";

export type When = { from: string; to: string; phrase: string; label: string };

const DAY_WORDS: [RegExp, DayKey][] = [
  [/mon(day)?/, "mon"],
  [/tue(s|sday)?/, "tue"],
  [/wed(nesday)?/, "wed"],
  [/thu(r|rs|rsday)?/, "thu"],
  [/fri(day)?/, "fri"],
  [/sat(urday)?/, "sat"],
  [/sun(day)?/, "sun"],
];
const FULL_DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/;
const SHORT_DAY = /\b(?:on|this|next|coming)\s+(?:a\s+)?(mon|tues?|wed|thu|thurs?|fri|sat|sun)\b/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const dayKey = (word: string) => DAY_WORDS.find(([re]) => new RegExp(`^${re.source}$`).test(word))?.[1] ?? null;
const pad = (n: number) => String(n).padStart(2, "0");
/** Monday of the week after this one. */
const nextMonday = (today: string) => addDays(today, 7 - WEEK.indexOf(weekdayOf(today)));

function range(from: string, to: string, phrase: string): When {
  return { from, to, phrase, label: from === to ? dateLabel(from) : `${dateLabel(from)} – ${dateLabel(to)}` };
}

function exactDate(q: string, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const build = (d: number, m: number, y?: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    let iso = `${y ?? year}-${pad(m)}-${pad(d)}`;
    if (!y && iso < today) iso = `${year + 1}-${pad(m)}-${pad(d)}`;
    return iso;
  };
  let m = /\b(20\d\d)-(\d{2})-(\d{2})\b/.exec(q);
  if (m) return build(Number(m[3]), Number(m[2]), Number(m[1]));
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`).exec(q);
  if (m) return build(Number(m[1]), MONTHS.indexOf(m[2].slice(0, 3)) + 1);
  m = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(q);
  if (m) return build(Number(m[2]), MONTHS.indexOf(m[1].slice(0, 3)) + 1);
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d\d))?\b/.exec(q);
  if (m) return build(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
  return null;
}

/** The dates a question is about, in Europe/London, or null when it names no time. */
export function resolveWhen(question: string, today = londonToday()): When | null {
  const q = question.toLowerCase();
  const date = exactDate(q, today);
  if (date) return range(date, date, `on ${dateLabel(date)}`);
  if (/\b(today|tonight|this evening)\b/.test(q)) return range(today, today, /tonight|evening/.test(q) ? "tonight" : "today");
  if (/\btomorrow\b/.test(q)) return range(addDays(today, 1), addDays(today, 1), "tomorrow");
  if (/\bnext weekend\b/.test(q)) {
    const sat = addDays(nextMonday(today), 5);
    return range(sat, addDays(sat, 1), "next weekend");
  }
  if (/\bweekend\b/.test(q)) {
    const wd = weekdayOf(today);
    const sat = wd === "sun" ? addDays(today, -1) : nextWeekday(today, "sat");
    return range(wd === "sun" ? today : sat, addDays(sat, 1), "this weekend");
  }
  if (/\bnext week\b/.test(q)) {
    const mon = nextMonday(today);
    return range(mon, addDays(mon, 6), "next week");
  }
  if (/\b(this week|this coming week|in the next few days)\b/.test(q)) return range(today, addDays(nextMonday(today), -1), "this week");
  const full = FULL_DAY.exec(q);
  const short = SHORT_DAY.exec(q);
  const word = full?.[1] ?? short?.[1];
  const key = word ? dayKey(word) : null;
  if (key) {
    const iso = new RegExp(`\\bnext\\s+${word}`).test(q)
      ? addDays(nextMonday(today), WEEK.indexOf(key))
      : nextWeekday(today, key);
    return range(iso, iso, `on ${dateLabel(iso)}`);
  }
  return null;
}

/** Every date in the range, capped at two weeks. */
export function datesIn(w: When) {
  const out: string[] = [];
  for (let d = w.from; d <= w.to && out.length < 14; d = addDays(d, 1)) out.push(d);
  return out;
}
