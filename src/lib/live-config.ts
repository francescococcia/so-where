// Live voice: the model, system prompt and tool declarations shared by /api/live-token (which locks them into the
// ephemeral token) and the browser hook (src/lib/live-session.ts). No secrets here; safe to bundle.
import type { FunctionDeclaration } from "@google/genai";

/** Hackathon model first; override with LIVE_MODEL (server) if a key can't open it. */
export const DEFAULT_LIVE_MODEL = "gemini-3.8-live";
export const LIVE_VOICE_NAME = "Aoede";

export const LIVE_SYSTEM_PROMPT = `You are the voice of "So where?", a London app that finds where to meet: a fair halfway spot, or what's on near the user.
Speak short, friendly British English by default: one or two sentences, warm, no lists, no filler.
Language: always answer in the language the user is speaking (Italian → Italian, Spanish → Spanish, and so on), switching whenever they do. Keep venue, station and line names exactly as the tools give them. Tool arguments (plan, refine) are always in English: translate the ask first. Use 24-hour London times said naturally ("half seven").
Tools:
- plan(query): for any new ask (who, where from, when, what kind of place). Pass the ask in the user's own words, completed with what they said earlier. Then say the top pick in one line and offer the others.
- refine(text): for follow-ups on the plan on screen ("cheaper", "quieter", "make it 8pm", "somewhere with food").
- focus(index or name): to open a place on the map ("tell me about the second one").
- isOpen(name): whether a place is open at the planned time.
- leaveBy(name): "when should I leave?".
- draftMessage(): when they want to send the plan. It only opens a draft; you can never send anything. Always say they need to tap Send themselves.
Rules: never claim you sent, booked or messaged anything. Never read out the other person's exact location, street or postcode; say "their side" or the area's broad name only if the app already showed it. Don't read out transport status or step-by-step routes; give minutes and a leave-by time at most. If a tool returns nothing useful, say so briefly and suggest one next step. If you didn't catch something, ask one short question.`;

export const LIVE_TOOLS: FunctionDeclaration[] = [
  {
    name: "plan",
    description: "Plan a new meet-up or find what's on. Runs the app's planner and returns a short summary of the top 3 picks.",
    parametersJsonSchema: { type: "object", properties: { query: { type: "string", description: "The full ask in plain English, e.g. 'Drinks Thursday at 7, I'm at Old Street, she's in Clapham, a pub halfway'." } }, required: ["query"] },
  },
  {
    name: "refine",
    description: "Change the plan on screen with a short follow-up, e.g. 'cheaper', 'quieter', 'make it 8pm'. Returns the app's one-line reply and the new top picks.",
    parametersJsonSchema: { type: "object", properties: { text: { type: "string", description: "The short refinement." } }, required: ["text"] },
  },
  {
    name: "focus",
    description: "Open one of the places on screen. Use index (1 = top pick) or name.",
    parametersJsonSchema: { type: "object", properties: { index: { type: "integer", description: "1-based position in the list." }, name: { type: "string" } } },
  },
  {
    name: "isOpen",
    description: "Check if a place on screen is open at the planned time. Name optional (defaults to the selected or top pick).",
    parametersJsonSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "leaveBy",
    description: "When the user should leave to arrive on time at a place on screen. Name optional.",
    parametersJsonSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "draftMessage",
    description: "Open the 'Send plan' draft for the user to review. Never sends anything; the user must tap Send.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
];

export type LiveToolCall =
  | { name: "plan"; args: { query: string } }
  | { name: "refine"; args: { text: string } }
  | { name: "focus"; args: { index?: number; name?: string } }
  | { name: "isOpen"; args: { name?: string } }
  | { name: "leaveBy"; args: { name?: string } }
  | { name: "draftMessage"; args: Record<string, never> };

/** App-side tool runner. Return one or two short sentences for the model to speak from (never raw locations). */
export type LiveToolHandler = (call: LiveToolCall) => Promise<string> | string;

export const LIVE_TOOL_NAMES = LIVE_TOOLS.map((t) => t.name as LiveToolCall["name"]);
