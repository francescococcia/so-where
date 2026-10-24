// Weather facts get a weather icon (rain / dry / mixed). Other facts return null so callers keep their verdict dot.
import { CloudRain, CloudSun, Sun } from "lucide-react";
import type { Fact } from "@/lib/plan-types";
import { cn } from "@/lib/utils";

export function weatherKind(f: Pick<Fact, "label" | "value">): "rain" | "dry" | "mixed" | null {
  const text = `${f.label} ${f.value}`;
  if (!/weather|forecast|rain|shower|drizzle|dry and|sunny|°\s?c|\b\d{1,2}\s?c\b/i.test(text)) return null;
  if (/rain|shower|drizzle|wet|storm/i.test(f.value)) return "rain";
  if (/dry|sun|clear|terrace/i.test(f.value)) return "dry";
  return "mixed";
}

export function WeatherIcon({ fact, className }: { fact: Pick<Fact, "label" | "value">; className?: string }) {
  const k = weatherKind(fact);
  if (!k) return null;
  const Icon = k === "rain" ? CloudRain : k === "dry" ? Sun : CloudSun;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-full",
        k === "rain" ? "bg-sky-soft text-sky-ink" : k === "dry" ? "bg-hi-soft text-likely" : "bg-fc-bg text-fc",
        className
      )}
    >
      <Icon className="size-3.5" strokeWidth={2.2} />
    </span>
  );
}

