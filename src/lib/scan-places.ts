// Client-side: the places named in an ask ("io vivo a waterloo e lui in westminister"), so the loading radar can fly to
// and pulse around them while the server plans. Only the bundled TfL station list (no network, nothing stored or logged).
// Mixed Italian/English words are skipped as stopwords; a place must be a confident gazetteer match.
import { matchPlace, normPlace } from "@/lib/gazetteer";
import type { LatLng } from "@/lib/plan-types";

export type ScanPlace = { name: string; at: LatLng };

const STOP = new Set(
  (
    "a an and the i im i'm me my we our you your he she they him her them his their is are be at in on to of for from by near " +
    "around with meet meeting friend friends coffee cafe café drink drinks pub pubs dinner lunch breakfast brunch tonight today tomorrow " +
    "live lives living work works stay stays want wanna need have has had go going get somewhere place halfway middle between " +
    "it its this that there here what when where which who how time later morning afternoon evening night weekend week " +
    "io tu lui lei noi voi loro mi ti si ci vi il lo la i gli le un uno una di da in con su per tra fra e ed o a al allo alla ai agli alle " +
    "del dello della dei degli delle nel nello nella nei negli nelle sul sulla dal dalla devo deve dobbiamo voglio vorrei vivo vive abito abita " +
    "lavoro lavora sono sta stai incontrare incontro vedere amico amica amici caffe caffè bere birra cena pranzo colazione domani oggi stasera " +
    "sera mattina pomeriggio dove quando che chi come metà meta mezzo vicino casa mio mia suo sua"
  ).split(/\s+/)
);

/** Named places in `text`, in order of appearance, best match per span (1–3 words), at most 4. */
export function scanPlaces(text: string): ScanPlace[] {
  const words = text.replace(/[^\p{L}\p{N}&' -]+/gu, " ").split(/\s+/).filter(Boolean);
  type Hit = { s: number; e: number; score: number; place: ScanPlace };
  const hits: Hit[] = [];
  for (let s = 0; s < words.length; s++) {
    if (STOP.has(words[s].toLowerCase())) continue;
    for (let n = 1; n <= 3 && s + n <= words.length; n++) {
      const span = words.slice(s, s + n);
      if (STOP.has(span[n - 1].toLowerCase()) && !/^(?:and|&)$/i.test(span[n - 1])) break;
      const phrase = span.join(" ");
      if (normPlace(phrase).length < 4) continue;
      const r = matchPlace(phrase, 2);
      if (r.confidence !== "high" || !r.best) continue;
      hits.push({ s, e: s + n, score: r.best.score + n * 0.01, place: { name: r.best.entry.name, at: r.best.entry.location } });
    }
  }
  // Greedy: best-scoring non-overlapping spans, then back in reading order; one entry per place.
  const taken: Hit[] = [];
  for (const h of hits.sort((a, b) => b.score - a.score)) if (!taken.some((t) => h.s < t.e && t.s < h.e) && !taken.some((t) => t.place.name === h.place.name)) taken.push(h);
  return taken.sort((a, b) => a.s - b.s).slice(0, 4).map((h) => h.place);
}

/** The middle of the named places (null with fewer than two). */
export function scanMiddle(places: ScanPlace[]): LatLng | null {
  if (places.length < 2) return null;
  return { lat: places.reduce((s, p) => s + p.at.lat, 0) / places.length, lng: places.reduce((s, p) => s + p.at.lng, 0) / places.length };
}
