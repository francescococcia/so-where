// Open-Meteo hourly forecast (no key, CC BY 4.0). Verdict is always "forecast".
import { getJson } from "@/lib/http";
import { londonParts } from "@/lib/london-time";
import type { LatLng } from "@/lib/plan-types";

type OM = { hourly?: { time: string[]; temperature_2m: number[]; precipitation_probability: (number | null)[]; precipitation?: (number | null)[]; is_day?: number[]; weather_code: number[] } };

const CODE: [number, string][] = [
  [0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [45, "fog"], [48, "fog"],
  [51, "light drizzle"], [53, "drizzle"], [55, "heavy drizzle"], [61, "light rain"], [63, "rain"], [65, "heavy rain"],
  [71, "light snow"], [73, "snow"], [75, "heavy snow"], [80, "showers"], [81, "showers"], [82, "heavy showers"], [95, "thunderstorms"],
];

export type Forecast = { value: string; tempC: number; rainPct: number | null; rainMm?: number | null; sunny?: boolean; fetchedAt: string; ms: number };

type ForecastFn = (p: LatLng, at: Date) => Promise<Forecast | { error: string; ms: number }>;
let override: ForecastFn | null = null;
/** Test/eval hook: replace the Open-Meteo call (null restores it). Never set in the app. */
export function setForecastOverride(fn: ForecastFn | null) {
  override = fn;
}

export async function forecastAt(p: LatLng, at: Date): Promise<Forecast | { error: string; ms: number }> {
  if (override) return override(p, at);
  const lat = p.lat.toFixed(2);
  const lng = p.lng.toFixed(2);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day&timezone=Europe%2FLondon&forecast_days=16`;
  const r = await getJson<OM>(url, { ttlMs: 15 * 60_000 });
  if (!r.ok) return { error: r.error, ms: r.ms };
  const lp = londonParts(at);
  const stamp = `${lp.date}T${String(lp.hh).padStart(2, "0")}:00`;
  const h = r.data.hourly;
  const i = h?.time.indexOf(stamp) ?? -1;
  if (!h || i < 0) return { error: "outside the 16-day forecast", ms: r.ms };
  const t = Math.round(h.temperature_2m[i]);
  const rain = h.precipitation_probability[i];
  const sky = CODE.find(([c]) => c === h.weather_code[i])?.[1] ?? "";
  const mm = h.precipitation?.[i] ?? null;
  return { value: `${t}°C${sky ? `, ${sky}` : ""}${rain != null ? `, ${rain}% chance of rain` : ""}`, tempC: t, rainPct: rain, rainMm: mm, sunny: h.weather_code[i] <= 1 && h.is_day?.[i] === 1, fetchedAt: r.fetchedAt, ms: r.ms };
}
