// Weather-aware venue choice: reads OSM seating tags (outdoor_seating, beer_garden / garden:type,
// indoor_seating, covered, amenity=biergarten) against the Open-Meteo forecast for the plan time.
// Wet → indoor / covered first; dry and warm → terraces and beer gardens first; otherwise no change.
import type { Fact } from "@/lib/plan-types";
import type { Forecast } from "@/lib/weather";

export type Seating = { outdoor_seating: boolean | null; indoor_seating: boolean | null; covered: boolean | null; beer_garden: boolean | null };
export type WeatherMode = { mode: "wet" | "warm" | "neutral"; label: string };

const yesNo = (v: string | undefined) =>
  v == null ? null : /^(yes|designated|pedestrian_zone|sidewalk|garden|terrace|patio|veranda|roof|balcony|partial|only|booth)$/i.test(v) ? true : v === "no" ? false : null;

/** Normalised seating flags from raw OSM tags: true / false when tagged, null when OSM doesn't say. */
export function seatingOf(t: Record<string, string>): Seating {
  const garden = t.amenity === "biergarten" || t.beer_garden === "yes" || t["garden:type"] === "beer_garden";
  return {
    outdoor_seating: garden ? true : yesNo(t.outdoor_seating),
    indoor_seating: yesNo(t.indoor_seating),
    covered: yesNo(t.covered),
    beer_garden: garden ? true : t.beer_garden === "no" ? false : null,
  };
}

export const RAIN_PCT = 40;
export const RAIN_MM = 0.2;
export const WARM_C = 16;

/** wet: rain ≥ 40 % or > 0.2 mm; warm: dry and ≥ 16 °C (or clear sky and ≥ 13 °C); else neutral. */
export function weatherMode(w: Forecast | { error: string } | null, clock: string): WeatherMode {
  if (!w || "error" in w) return { mode: "neutral", label: "no forecast, venues not weather-ranked" };
  const pct = w.rainPct ?? 0;
  const mm = w.rainMm ?? 0;
  if (pct >= RAIN_PCT || mm > RAIN_MM) return { mode: "wet", label: `Rain likely at ${clock} (${w.rainPct ?? "?"}%${mm > 0 ? `, ${mm} mm` : ""})` };
  if (w.tempC >= WARM_C || (w.sunny && w.tempC >= 13)) return { mode: "warm", label: `Dry and ${w.tempC}°C${w.sunny ? ", sunny" : ""}` };
  return { mode: "neutral", label: `${w.tempC}°C, ${w.rainPct ?? "?"}% rain - neither wet nor warm, venues not weather-ranked` };
}

/** Lower = better for this weather. Untagged venues sit in the middle. */
export function weatherRank(tags: Record<string, string>, m: WeatherMode): number {
  const s = seatingOf(tags);
  if (m.mode === "wet") {
    if (s.indoor_seating === true || s.covered === true) return 0;
    if ((tags.amenity === "biergarten" || tags.outdoor_seating === "only")) return 2; // outdoor-only
    if (s.indoor_seating === false) return 2;
    return 1;
  }
  if (m.mode === "warm") return s.outdoor_seating === true || s.beer_garden === true ? 0 : 1;
  return 0;
}

/** Card fact for wet / warm plans; null when the weather doesn't change the choice. */
export function weatherFitFact(tags: Record<string, string>, m: WeatherMode, osmSource: string, asOf: string | undefined, wxAsOf: string): Fact | null {
  if (m.mode === "neutral") return null;
  const s = seatingOf(tags);
  const source = `${osmSource} + Open-Meteo`;
  const at = asOf ?? wxAsOf;
  if (m.mode === "wet") {
    if (s.indoor_seating === true || s.covered === true)
      return { label: "Weather fit", value: `${m.label} - ${s.covered === true ? "covered seating" : "indoor seating"} (OSM tag)`, verdict: "confirmed", source, asOf: at };
    if (s.indoor_seating === false || ((tags.amenity === "biergarten" || tags.outdoor_seating === "only") && s.indoor_seating == null))
      return { label: "Weather fit", value: `${m.label} - outdoor only per OSM`, verdict: "confirmed", source, asOf: at };
    return { label: "Weather fit", value: `${m.label} - indoor seating not tagged in OSM`, verdict: "unknown", source };
  }
  const garden = s.beer_garden === true;
  if (garden || s.outdoor_seating === true)
    return { label: "Weather fit", value: `${m.label} - has a ${garden ? "beer garden" : "terrace / outdoor seating"} (OSM tag)`, verdict: "confirmed", source, asOf: at };
  return { label: "Weather fit", value: `${m.label} - outdoor seating not tagged in OSM`, verdict: "unknown", source };
}

/** One line for the venues step: what the weather decided. */
export function weatherDecision(m: WeatherMode, picks: { tags: Record<string, string> }[]): string {
  if (m.mode === "neutral") return `weather: ${m.label}`;
  const fit = picks.filter((p) => weatherRank(p.tags, m) === 0).length;
  return m.mode === "wet"
    ? `weather: ${m.label} → indoor/covered first (${fit} of ${picks.length} kept tagged indoor/covered in OSM)`
    : `weather: ${m.label} → terraces/beer gardens first (${fit} of ${picks.length} kept tagged outdoor in OSM)`;
}
