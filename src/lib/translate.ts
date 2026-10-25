// "Speak any language": detect + translate the user's ask to English before planning, and the spoken reply back.
// Text: gemini-3.5-flash-lite (fast), then gemini-3.8-flash. Audio: gemini-3.5-live-translate-preview over the Live API
// (it only speaks bidiGenerateContent; it streams back an English transcript of what was said).
// Nothing here logs or stores the user's text or audio. Server only.
import { GoogleGenAI, Modality } from "@google/genai";

export const TEXT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
export const AUDIO_MODEL = "gemini-3.5-live-translate-preview";

/** Translations come back as natural English ("See you at X", "Let's meet at X"); the planner's rules read "Meet at X". */
export function plannerEnglish(t: string): string {
  return t
    .replace(/^\s*(?:see you|let'?s meet|we(?:'ll| will)? meet|i(?:'ll| will)? meet you|meeting)\s+(at|in|by)\b/i, (_m, p: string) => `Meet ${p.toLowerCase()}`)
    .replace(/^\s*(?:take|bring|get) me to\b/i, "Get me to")
    .replace(/^\s*(?:a\s+)?caf[eé]s?\b/i, "Coffee");
}

export type Translation = { lang: string; langName: string; english: string; model: string | null; original?: string };

/** Native names for the chip ("Italiano · translated by …"). */
export const LANG_NAMES: Record<string, string> = {
  en: "English", it: "Italiano", es: "Español", fr: "Français", de: "Deutsch", pt: "Português", nl: "Nederlands",
  pl: "Polski", ro: "Română", tr: "Türkçe", ar: "العربية", hi: "हिन्दी", bn: "বাংলা", ur: "اردو", zh: "中文", ja: "日本語",
  ko: "한국어", ru: "Русский", uk: "Українська", el: "Ελληνικά", sv: "Svenska",
};
const LANG_EN: Record<string, string> = {
  en: "English", it: "Italian", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", nl: "Dutch", pl: "Polish", ro: "Romanian",
  tr: "Turkish", ar: "Arabic", hi: "Hindi", bn: "Bengali", ur: "Urdu", zh: "Chinese", ja: "Japanese", ko: "Korean", ru: "Russian",
  uk: "Ukrainian", el: "Greek", sv: "Swedish",
};
export const langEnglishName = (code: string) => LANG_EN[code] ?? code.toUpperCase();
export const langName = (code: string) => LANG_NAMES[code] ?? code.toUpperCase();

// Common function words of the languages people are likely to type; a hit means "not plainly English".
const FOREIGN = /\b(ci|vediamo|vicino|della|dalla|alle|sono|dove|quando|stasera|domani|oggi|voglio|cerca|cerco|caffè|caffe|una|uno|il|gli|le|per|con|che|del|da|all|alla|al|de|la|las|los|el|cerca|quiero|dónde|donde|mañana|hoy|esta|noche|nos|vemos|café|en|y|un|une|des|du|au|aux|près|pres|où|ou|ce|soir|demain|veux|avec|chez|der|die|das|und|ich|wir|treffen|morgen|heute|abend|wo|nach|mit|bei|um|ein|eine|não|nao|perto|amanhã|onde|vamos|encontrar)\b/giu;
const EN = /\b(the|and|to|from|near|in|at|with|for|me|my|i'm|im|we|us|let's|lets|meet|coffee|drinks?|pub|bar|dinner|lunch|tonight|tomorrow|today|friend|she|he|they|is|are|halfway|somewhere|place|after|before|around|quiet|cheap|cheaper|food|open|walk|minutes|what's|whats|on|of|a|an|it|this|that|thursday|friday|saturday|sunday|monday|tuesday|wednesday|pm|am|o'clock)\b/gi;

/**
 * Cheap, model-free check run before any translation call: true when the text is plainly English (or too short to tell,
 * e.g. a station name). Non-Latin scripts and accented words count against English. English stays on the old fast path.
 */
export function looksEnglish(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[\u0370-\u03ff\u0400-\u04ff\u0590-\u06ff\u0900-\u0dff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && !/[¿¡àèìòùáéíóúñçãõâêôäöüß]/i.test(t)) return true; // "Greenwich", "Old Street"
  const foreign = (t.match(FOREIGN) ?? []).length + (t.match(/[¿¡àèìòùáéíóúñçãõâêôäöüßœ]/gi) ?? []).length;
  const en = (t.match(EN) ?? []).length;
  return foreign === 0 ? true : en > foreign * 1.5;
}

let client: GoogleGenAI | null = null;
const ai = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return (client ??= new GoogleGenAI({ apiKey: key }));
};
const dead = new Set<string>();

async function textCall(prompt: string, timeoutMs = 6000): Promise<{ text: string; model: string } | null> {
  const g = ai();
  if (!g) return null;
  const models = [process.env.TRANSLATE_MODEL, ...TEXT_MODELS].filter((m, i, a): m is string => !!m && a.indexOf(m) === i && !dead.has(m));
  for (const model of models) {
    try {
      const res = await Promise.race([
        g.models.generateContent({ model, contents: prompt, config: { temperature: 0, responseMimeType: "application/json" } }),
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
      ]);
      const text = res?.text?.trim();
      if (text) return { text, model };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 403) dead.add(model);
    }
  }
  return null;
}

const parse = (s: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(s.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const code = (v: unknown) => (typeof v === "string" && /^[a-z]{2,3}$/i.test(v.trim()) ? v.trim().toLowerCase().slice(0, 2) : "en");

/** User text (any language) → English. `hint` = the language picked in the UI ("auto" or a code). */
export async function toEnglish(text: string, hint?: string): Promise<Translation | null> {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 600);
  const r = await textCall(
    `Detect the language of the user's message to a London meet-up planner and translate it to natural English.
Keep place names, station names, venue names and times exactly as written (e.g. "Old Royal Naval College", "Old Street").${hint && hint !== "auto" ? ` The user picked language "${hint}".` : ""}
Reply only with JSON: {"lang":"<ISO 639-1 code>","english":"<translation>"}
Message: ${JSON.stringify(t)}`,
  );
  if (!r) return null;
  const o = parse(r.text);
  const english = typeof o?.english === "string" ? o.english.trim() : "";
  if (!english) return null;
  const lang = code(o?.lang);
  return { lang, langName: langName(lang), english: plannerEnglish(english).slice(0, 500), model: r.model };
}

/** English reply → the user's language, venue names and times kept as-is. */
export async function fromEnglish(text: string, lang: string): Promise<{ text: string; model: string } | null> {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 600);
  const r = await textCall(
    `Translate this short spoken reply from a London meet-up app into ${langName(lang)} (${lang}). Natural, friendly, spoken style.
Keep venue names, station names, line names, times and app button labels in double quotes (e.g. "Send plan", "Copy text", "Share", "Directions") exactly as written, quotes included; do not add anything.
Reply only with JSON: {"text":"<translation>"}
Reply: ${JSON.stringify(t)}`,
  );
  if (!r) return null;
  const out = parse(r.text)?.text;
  return typeof out === "string" && out.trim() ? { text: out.trim().slice(0, 700), model: r.model } : null;
}

/**
 * Spoken ask (16 kHz 16-bit mono PCM) → {original, english} via gemini-3.5-live-translate-preview. The model is
 * real-time only, so audio is paced at 2× speed with a short silence tail, and we stop once its English transcript
 * goes quiet. Null when the model can't be opened or says nothing (the caller falls back to typing / Web Speech).
 */
export async function audioToEnglish(pcm: Buffer): Promise<{ original: string; english: string; model: string } | null> {
  const g = ai();
  if (!g || dead.has(AUDIO_MODEL)) return null;
  const audio = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 2)]);
  let english = "";
  let original = "";
  let lastOut = 0;
  let closed = false;
  let session: Awaited<ReturnType<typeof g.live.connect>> | null = null;
  try {
    session = await g.live.connect({
      model: AUDIO_MODEL,
      config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {}, inputAudioTranscription: {} },
      callbacks: {
        onmessage: (m) => {
          const sc = m.serverContent;
          if (sc?.outputTranscription?.text) { english += sc.outputTranscription.text; lastOut = Date.now(); }
          if (sc?.inputTranscription?.text) original += sc.inputTranscription.text;
        },
        onerror: () => { closed = true; },
        onclose: () => { closed = true; },
      },
    });
    const chunk = 3200; // 100 ms
    for (let i = 0; i < audio.length && !closed; i += chunk) {
      session.sendRealtimeInput({ audio: { data: audio.subarray(i, i + chunk).toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      await new Promise((r) => setTimeout(r, 50));
    }
    const until = Date.now() + 4500;
    while (!closed && Date.now() < until && (!lastOut || Date.now() - lastOut < 1300)) await new Promise((r) => setTimeout(r, 100));
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404 || status === 403) dead.add(AUDIO_MODEL);
    return null;
  } finally {
    try { session?.close(); } catch {}
  }
  english = english.replace(/\s+/g, " ").trim();
  original = original.replace(/\s+/g, " ").trim();
  return english ? { original: original || english, english: plannerEnglish(english), model: AUDIO_MODEL } : null;
}

/** Language of a short transcript, for the chip and the reply language (cheap text call). */
export async function detectLang(text: string): Promise<{ lang: string; model: string } | null> {
  if (looksEnglish(text)) return { lang: "en", model: "rules" };
  const r = await textCall(`What language is this? Reply only with JSON {"lang":"<ISO 639-1 code>"}. Text: ${JSON.stringify(text.slice(0, 300))}`, 4000);
  return r ? { lang: code(parse(r.text)?.lang), model: r.model } : null;
}
