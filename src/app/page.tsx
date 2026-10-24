import fs from "node:fs";
import path from "node:path";
import { SoWhereApp } from "@/components/so-where/so-where-app";

/**
 * "Tested on N asks": read evals/last-run.json at build time. No file → no badge.
 * Never hardcode N.
 */
function testedCount(): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals", "last-run.json"), "utf8"));
    const pick = (v: unknown) => (typeof v === "number" ? v : Array.isArray(v) ? v.length : null);
    if (Array.isArray(raw)) return raw.length || null;
    for (const k of ["n", "total", "count", "asks", "cases", "results", "runs"]) {
      const n = pick(raw?.[k]);
      if (n) return n;
    }
    if (typeof raw?.passed === "number" && typeof raw?.failed === "number") return raw.passed + raw.failed || null;
    return null;
  } catch {
    return null;
  }
}

export const dynamic = "force-static";

export default function Home() {
  return <SoWhereApp testedN={testedCount()} />;
}
