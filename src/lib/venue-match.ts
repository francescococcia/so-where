// Finds venue names in free text, tolerating "&"/"and", apostrophes and spacing ("The Sanctuary &Soul").

const SEP = "[^\\p{L}\\p{N}]*";

function tokens(name: string) {
  return name
    .split(",")[0]
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Case-insensitive regex for a venue name, or null for names too short to match safely. */
export function nameRegex(name: string, flags = "iu"): RegExp | null {
  const t = tokens(name);
  if (!t.length || t.join("").length < 4) return null;
  const body = t.map((w) => (w === "and" ? "(?:and|&)" : w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(SEP);
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
}

/** Items whose name appears in the text, in order of first mention. */
export function mentionedIn<T extends { name: string }>(text: string, items: T[]): T[] {
  const hits: { item: T; at: number }[] = [];
  for (const item of items) {
    const at = nameRegex(item.name)?.exec(text)?.index;
    if (at !== undefined && !hits.some((h) => h.item.name === item.name)) hits.push({ item, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.item);
}
