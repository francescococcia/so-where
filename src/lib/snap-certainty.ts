// How sure "Snap a place" is, and what to say when it isn't. The vision model returns
// certainty: high | medium | low plus an issue (blurry, dark, …) via structured output; judgeSnap() then
// cross-checks that against the numbers and the sign text, and never lets a low read carry a place name.
//   high   → match and show the place as before.
//   medium → match, but the UI asks "Is this <place>, <area>?" (Yes / Not this one) before using it.
//   low    → no matching, no name: say what was unclear ("Too blurry to read the sign") → Retake / Type the name.
export const LEVELS = ["high", "medium", "low"] as const;
export type SnapCertainty = (typeof LEVELS)[number];
export const ISSUES = ["blurry", "dark", "far", "cropped", "glare", "no_sign", "ambiguous", "not_a_place"] as const;
export type SnapIssue = (typeof ISSUES)[number];

/** Short, plain copy for each issue (shown as the reason). */
export const ISSUE_TEXT: Record<SnapIssue, string> = {
  blurry: "Too blurry to read the sign",
  dark: "Too dark to read the sign",
  far: "The sign is too far away to read",
  cropped: "The sign is cut off",
  glare: "Glare is hiding the sign",
  no_sign: "Can't see a sign or name",
  ambiguous: "It could be more than one place",
  not_a_place: "This doesn't look like a place",
};

type Read = { name: string | null; signText: string | null; confidence: number; certainty?: SnapCertainty; issue?: SnapIssue | null; landmark?: { name: string; confidence: number } | null };
export type SnapJudgement = { certainty: SnapCertainty; reason: string | null };

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !/^(the|and|of|ye|bar|pub|cafe|ltd)$/.test(w));
/** Is every significant word of the name actually on the sign? */
export function nameOnSign(name: string, sign: string | null) {
  if (!sign) return false;
  const on = new Set(words(sign).concat(words(sign.replace(/\s+/g, ""))));
  const n = words(name);
  return n.length > 0 && n.every((w) => on.has(w) || [...on].some((s) => s.length > 3 && (s.startsWith(w) || w.startsWith(s))));
}

/** The final level + reason. Rules on top of the model's own level:
 *  - a name read at confidence < 0.3 is low; < 0.6 is at most medium;
 *  - a venue name that isn't on the sign text it read is at most medium (could be a guess);
 *  - a landmark read only from its architecture, under 0.8, is at most medium. */
export function judgeSnap(x: Read): SnapJudgement {
  let level: SnapCertainty = x.certainty ?? (!x.name ? "medium" : x.confidence >= 0.8 ? "high" : x.confidence >= 0.5 ? "medium" : "low");
  const demote = (to: SnapCertainty) => {
    if (LEVELS.indexOf(to) > LEVELS.indexOf(level)) level = to;
  };
  const lm = x.landmark && !x.name ? x.landmark : null;
  if (x.name) {
    if (x.confidence < 0.3) demote("low");
    else if (x.confidence < 0.6) demote("medium");
    if (!nameOnSign(x.name, x.signText) && !x.landmark) demote("medium");
  } else if (lm) {
    if (lm.confidence < 0.5) demote("low");
    else if (lm.confidence < 0.8) demote("medium");
  }
  const reason = x.issue ? ISSUE_TEXT[x.issue] : level === "low" ? "Couldn't read the sign clearly" : level === "medium" ? "Not fully clear" : null;
  return { certainty: level, reason: level === "high" && !x.issue ? null : reason };
}
