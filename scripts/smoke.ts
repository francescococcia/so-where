// npm run smoke — the two demo asks through POST /api/plan (NDJSON stream), live network; saves evals/smoke-output.json.
import { writeFileSync } from "node:fs";
import { POST } from "@/app/api/plan/route";

const YOU = { lat: 51.529, lng: -0.083 }; // Encode Hub, 41 Pitfield St
const ASKS = [
  { query: "Date on Thursday at 7. I'm at Old Street, she's around Clapham. A pub halfway, about £40 for two.", you: YOU },
  { query: "It's Saturday, what's on near me that I can just walk into?", you: YOU },
];

(async () => {
  const runs = [];
  for (const ask of ASKS) {
    const t0 = Date.now();
    const res = await POST(new Request("http://local/api/plan", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify(ask) }));
    const text = await res.text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    const ms = Date.now() - t0;
    const final = lines[lines.length - 1];
    console.log(`\n▶ ${ask.query}  (${ms} ms, ${lines.length - 1} step events)`);
    for (const l of lines) if (l.type === "step" && l.step.status !== "running") console.log(`  ${l.step.status.padEnd(7)} ${l.step.label} — ${l.step.detail ?? ""} [${l.step.ms} ms]`);
    if (final.type === "result") {
      const r = final.result;
      console.log(`  ${r.headline}`);
      for (const c of r.cards) console.log(`  • ${c.name} — ${c.subtitle}\n    ${c.facts.map((f: { label: string; value: string; verdict: string }) => `${f.label}: ${f.value} [${f.verdict}]`).join("\n    ")}`);
      console.log(`  unknowns: ${r.unknowns.join(" | ")}`);
      console.log(`  sources: ${r.sources.map((s: { name: string; asOf: string }) => `${s.name} @ ${s.asOf}`).join(", ")}`);
      console.log(`  draft: ${r.draftMessage}`);
    } else console.log("  ", JSON.stringify(final));
    runs.push({ ask, ms, stepEvents: lines.filter((l) => l.type === "step").length, final });
  }
  writeFileSync("evals/smoke-output.json", JSON.stringify({ ranAt: new Date().toISOString(), runs }, null, 2) + "\n");
})();
