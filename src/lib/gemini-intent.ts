// Optional: Gemini Flash fills gaps the rules left (only when GEMINI_API_KEY is set). Rules always run first
// and win; any Gemini error or timeout is ignored. Uses thinkingLevel (not thinkingBudget) and sets no
// temperature / top_p / top_k. Server-side only.
import type { PlanAsk } from "@/lib/ask-local";

const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

export async function geminiFill(query: string, rules: PlanAsk, today: string): Promise<{ ask: PlanAsk; used: boolean; filled: string[]; ms: number; error?: string }> {
  const key = process.env.GEMINI_API_KEY;
  const t0 = Date.now();
  if (!key) return { ask: rules, used: false, filled: [], ms: 0 };
  const prompt = `Today is ${today} (Europe/London). Extract from this London plan request, as JSON with keys:
intent ("meet_halfway" if meeting another person between two places, "near_me" if looking for things near the asker, or null),
youPlace (the asker's station/area or null), themPlace (the other person's station/area or null), date (YYYY-MM-DD or null), time (HH:MM 24h or null),
category ("pub"|"cafe"|"restaurant"|"event"|null), budgetGBP (number|null), walkIn (boolean). Use null when not stated. Do not guess places.
Request: ${JSON.stringify(query)}`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ask: rules, used: false, filled: [], ms: Date.now() - t0, error: `HTTP ${res.status}` };
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const g = JSON.parse(text) as Partial<PlanAsk>;
    const ask = { ...rules };
    const filled: string[] = [];
    const fill = <K extends keyof PlanAsk>(k: K, ok: (v: unknown) => boolean) => {
      if ((ask[k] == null || ask[k] === false) && g[k] != null && ok(g[k])) {
        (ask as Record<string, unknown>)[k] = g[k];
        filled.push(String(k));
      }
    };
    fill("intent", (v) => v === "meet_halfway" || v === "near_me");
    // Only accept places Gemini found verbatim in the text, so it can't invent one.
    const inText = (v: unknown) => typeof v === "string" && v.length > 2 && query.toLowerCase().includes(v.toLowerCase());
    fill("youPlace", inText);
    fill("themPlace", inText);
    fill("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
    fill("time", (v) => typeof v === "string" && /^\d{2}:\d{2}$/.test(v));
    fill("category", (v) => ["pub", "cafe", "restaurant", "event"].includes(String(v)));
    fill("budgetGBP", (v) => typeof v === "number" && v > 0 && v < 10000);
    const WORDS: Record<string, string> = { intent: "plan type", youPlace: "your place", themPlace: "their place", date: "day", time: "time", category: "kind of place", budgetGBP: "budget" };
    if (filled.length) ask.signals = [...ask.signals, `Gemini filled: ${filled.map((k) => WORDS[k] ?? k).join(", ")}`];
    return { ask, used: true, filled, ms: Date.now() - t0 };
  } catch (e) {
    return { ask: rules, used: false, filled: [], ms: Date.now() - t0, error: String((e as Error)?.name ?? e) };
  }
}
