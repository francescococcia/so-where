// Off-script follow-ups after a plan ("send it to my friend", "thanks", "is it busy?", "start over"): cheap rules that
// run before the refine parser, so a how-to / share / chit-chat question is never read as "change the plan".
// Answers come only from the plan on screen (its facts, legs and steps); anything we don't have is said plainly,
// with the venue link. Pure (no I/O, no model call); the user's text is never logged or stored.
// Replies are English, except when the raw text is plainly Italian or Spanish (no translation ran): then the reply is
// written in that language. The UI translates English replies into the conversation's language as before.
import type { PlanCard, PlanResultWithAgent } from "@/lib/plan-types";

export type ChatKind =
  | "share" | "thanks" | "directions" | "call" | "book" | "weather" | "step_free" | "price" | "busy" | "dog" | "wifi"
  | "start_over" | "about" | "travel_mode";
/** What the UI should surface: highlight Send plan / Directions, or clear to a fresh ask. Never sends anything. */
export type ChatAction = "share" | "directions" | "start_over";
export type ChatIntent = { kind: ChatKind; mode?: "bike" | "walk" | "car" };
type Lang = "en" | "it" | "es";

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[¿¡!?.,;:"“”'’]/g, " ").replace(/\s+/g, " ").trim();

/** Plainly Italian / Spanish raw text (short replies the translator skipped, or no translation at all). */
export function chatLang(text: string): Lang {
  const t = ` ${norm(text)} `;
  const it = (t.match(/ (perfetto|grazie|ciao|faccio|percorso|amico|amica|mandalo|mandala|mandaglielo|inviagli|invialo|inviale|condividi|ricomincia|ricominciamo|chi sei|cosa sai|che tempo|piove|cane|quanto costa|costa|domani|alle|indicazioni|ottimo|va bene|come ci arrivo|chiama|prenota|c e|si puo|puo|posso|gente|affollato|lì|li|aiuto|bici|piedi|non|cosa|che|sono|per|questo|questa|voglio|vorrei|perche|boh|dove|quando|anche|niente) /g) ?? []).length;
  const es = (t.match(/ (gracias|envialo|enviaselo|enviale|mandaselo|compartelo|comparte|hay|mucha|gente|como llego|perro|cuanto cuesta|cuesta|manana|quien eres|que puedes|vale|perfecto|tiempo|lluvia|llueve|llama|reserva|empezar|de nuevo|ayuda|bici|andando|caminando|puedo|que|quiero|donde|cuando|tambien|nada|esto|por favor|pero|sitio) /g) ?? []).length;
  if (it > es && it > 0) return "it";
  if (es > it && es > 0) return "es";
  return "en";
}

// Order matters: share before thanks ("perfetto, come faccio per inviarglielo"), facts before travel.
const SHARE = [
  /\b(?:send|share|forward|text|message|whatsapp|pass on|pass)\b.{0,40}\b(?:it|this|that|plan|route|link|details|directions|place|address|location|him|her|them|friend|mate|partner|date|girlfriend|boyfriend|wife|husband|mum|mom|dad|group|everyone)\b/,
  /\bhow (?:do|can|should|could) (?:i|we)\b.{0,20}\b(?:send|share|forward|tell|let)\b/,
  /^(?:please )?(?:send|share|forward)(?: it| this| that)?(?: please)?$/,
  /\blet (?:him|her|them|my friend|[a-z]+) know\b/,
  // Italian (raw): inviagli, invialo, mandalo, mandaglielo, condividi, giraglielo, inoltra
  /\b(?:invia\w*|invio|invialo|mand(?:a|o|alo|ala|ali|agli\w*|ale\w*|amelo|aglielo)|condivid\w*|gira(?:gli|le)\w*|inoltr\w*)\b/,
  // Spanish (raw): envíaselo, envíale, mándaselo, compártelo, reenvía
  /\b(?:envi[ae]\w*|mandaselo|mandale\w*|compart\w*|reenvi\w*)\b/,
];
const THANKS = /^(?:(?:ok(?:ay)?|okey|k|cool|great|perfect|nice|lovely|brilliant|awesome|sounds good|good|fine|got it|cheers|thanks?(?: you)?(?: so much)?|thx|ty|grazie(?: mille)?|perfetto|ottimo|va bene|bene|benissimo|d accordo|gracias|perfecto|vale|genial|de acuerdo|vale gracias|merci|danke|👍|🙏|❤️|yes|yep|si)\s*)+$/;
const START_OVER = /^(?:let s |lets |can we |please )?(?:start (?:over|again|afresh)|restart|reset|new (?:plan|search|ask)|from scratch|clear(?: it| all)?|ricomincia(?:mo|re)?|da capo|nuova ricerca|empez(?:ar|emos) de nuevo|otra vez|reiniciar|nueva busqueda)\b/;
const ABOUT = /\b(?:who are you|what are you|what can you do|what do you do|how does this work|how do you work|help(?: me)?$|^help\b|chi sei|cosa (?:sai|puoi) fare|come funziona|aiuto|quien eres|que puedes hacer|como funciona|ayuda)\b/;
const DIRECTIONS = /\b(?:directions?|how (?:do|can) (?:i|we) get there|how to get there|get there|route there|show (?:me )?the (?:way|route)|google maps|apple maps|maps|navigate|navigation|open (?:it )?in maps|come ci arrivo|come arrivo|indicazioni|percorso|como llego|como llegar|indicaciones|ruta)\b/;
const MODE = /\b(?:by bike|bike|cycl\w*|bicycle|in bici|bici(?:cletta)?|en bici|bicicleta|on foot|walk(?:ing)?|a piedi|andando|caminando|a pie|drive|driving|by car|in macchina|en coche|taxi|uber|cab)\b/;
const CALL = /\b(?:call (?:them|it|the (?:place|venue|pub|cafe|restaurant))|phone(?: number)?|their number|telephone|chiama(?:li|re)?|numero di telefono|telefono|llama(?:les|r)?|numero)\b/;
const BOOK = /\b(?:book (?:a )?(?:table|it|there)|can you book|make a (?:booking|reservation)|reserve|reservation|prenota\w*|reserva\w*)\b/;
const WEATHER = /\b(?:weather|forecast|rain(?:ing|y)?|umbrella|sunny|temperature|how (?:cold|warm|hot)|che tempo|meteo|piove|pioggia|ombrello|tiempo hace|que tiempo|llueve|lluvia|paraguas)\b/;
const STEP_FREE = /\b(?:step[- ]?free|wheelchair|accessible|accessibility|disabled access|pram|buggy|stroller|stairs|lift|elevator|sedia a rotelle|senza gradini|accessibil\w*|silla de ruedas|accesible)\b/;
const PRICE = /\b(?:how much|what does .{1,30} cost|what(?:'s| is) the price|price of|prices?|cost(?:s)?|expensive|pricey|quanto costa|quanto viene|prezz\w*|costa|cuanto cuesta|cuanto vale|precio\w*|caro)\b/;
const BUSY = /\b(?:busy|crowded|packed|rammed|full|queue|queues|wait(?:ing)? time|many people|lots of people|affollat\w*|pieno|gente|coda|lleno|mucha gente|cola)\b/;
const DOG = /\b(?:dogs?|pets?|puppy|cane|cani|perro|perros|mascota\w*)\b/;
const WIFI = /\b(?:wi-?fi|internet|laptop|plugs?|sockets?|charge my phone|work from there|presa|enchufe)\b/;
// Refinements win over chit-chat: a time, a day, a type or a preference means "change the plan".
const REFINEISH = /\b(?:\d{1,2}(?::\d\d)?\s*(?:am|pm)?\b|tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|cheaper|quieter|closer|nearer|instead|different|another|alternative|other|pub|bar|cafe|coffee|restaurant|italian|terrace|indoor|outdoor)\b/;

/** A follow-up that isn't a plan change, or null (then the refine parser runs as before). */
export function chatIntent(text: string): ChatIntent | null {
  const t = norm(text);
  if (!t || t.length > 200) return null;
  if (SHARE.some((re) => re.test(t))) return { kind: "share" };
  if (THANKS.test(t)) return { kind: "thanks" };
  if (START_OVER.test(t)) return { kind: "start_over" };
  if (ABOUT.test(t)) return { kind: "about" };
  if (STEP_FREE.test(t)) return { kind: "step_free" };
  if (WEATHER.test(t) && !/\b(?:indoors?|inside|terrace|outdoor|somewhere)\b/.test(t)) return { kind: "weather" };
  // Fact questions about the place on screen ("how much is a pint there", "is it busy", "can I bring my dog").
  const asks = /\b(?:is|are|do|does|can|could|will|how|what|any|there|quanto|si puo|posso|c e|ci sono|hay|puedo|se puede|cuanto)\b|\?/.test(t) || t.split(" ").length <= 3;
  if (asks && PRICE.test(t) && !/\bcosta coffee\b|\binstead\b/.test(t) && !/\b(?:cheaper|less|under|budget|meno|piu economico|mas barato)\b/.test(t)) return { kind: "price" };
  if (asks && BUSY.test(t) && !/\b(?:less|not too|quieter|meno|menos)\b/.test(t)) return { kind: "busy" };
  if (DOG.test(t)) return { kind: "dog" };
  if (WIFI.test(t)) return { kind: "wifi" };
  if (BOOK.test(t)) return { kind: "book" };
  if (CALL.test(t)) return { kind: "call" };
  const m = MODE.exec(t);
  if (m && !REFINEISH.test(t.replace(m[0], ""))) {
    const w = m[0];
    return { kind: "travel_mode", mode: /bike|cycl|bici/.test(w) ? "bike" : /walk|foot|piedi|andando|caminando|pie/.test(w) ? "walk" : "car" };
  }
  if (DIRECTIONS.test(t) && !REFINEISH.test(t) && !/\b(?:leave|when|partire|salir)\b/.test(t)) return { kind: "directions" };
  return null;
}

const factOf = (c: PlanCard | undefined, re: RegExp) => c?.facts.find((f) => re.test(f.label));
const linkNote = (c: PlanCard | undefined, l: Lang) =>
  c?.url ? ({ en: ` Check ${c.name}'s page (tap the card, then the link) or ask them.`, it: ` Controlla la pagina di ${c.name} (tocca la scheda, poi il link) o chiedi a loro.`, es: ` Mira la página de ${c.name} (toca la tarjeta y luego el enlace) o pregúntales.` })[l]
    : ({ en: " Best to ask them.", it: " Meglio chiedere a loro.", es: " Mejor preguntarles." })[l];

/** The reply (and what the UI should surface) for a chat intent, from the plan on screen only. */
export function chatReply(intent: ChatIntent, result: PlanResultWithAgent | null, card: PlanCard | undefined, raw: string): { reply: string; action?: ChatAction; detail: string } {
  const l = chatLang(raw);
  const name = card?.name;
  const T = (en: string, it: string, es: string) => ({ en, it, es })[l];
  switch (intent.kind) {
    case "share":
      return {
        action: "share",
        detail: "Share: Send plan highlighted · nothing sent",
        reply: T(
          'Tap "Send plan" for a ready message with the place, time and route, then "Copy text" or "Share". Nothing is sent until you do.',
          'Tocca "Send plan": c\'è già il messaggio con posto, orario e percorso, poi "Copy text" o "Share". Non parte nulla finché non lo fai tu.',
          'Toca "Send plan": tienes el mensaje listo con el sitio, la hora y la ruta, luego "Copy text" o "Share". No se envía nada hasta que tú lo hagas.',
        ),
      };
    case "thanks":
      return { detail: "Thanks: no change", reply: T("You're welcome. Enjoy! Ask if you want to change anything.", "Di niente, buon divertimento! Chiedimi pure se vuoi cambiare qualcosa.", "¡De nada, que lo disfrutes! Dime si quieres cambiar algo.") };
    case "start_over":
      return { action: "start_over", detail: "Start over: cleared", reply: T("Sure, starting fresh. What are you planning?", "Certo, ricominciamo. Cosa vuoi organizzare?", "Claro, empezamos de nuevo. ¿Qué quieres planear?") };
    case "about":
      return {
        detail: "About: capabilities",
        reply: T(
          "I'm So Where: I find a place that's open, fair for both of you, with real travel times. Ask me to change the time, the type or the vibe, send it to your friend, show directions or say when to leave.",
          "Sono So Where: trovo un posto aperto, comodo per tutti e due, con tempi di viaggio reali. Posso cambiare orario, tipo o atmosfera, preparare il messaggio per il tuo amico, darti le indicazioni o dirti quando partire.",
          "Soy So Where: encuentro un sitio abierto, justo para los dos, con tiempos de viaje reales. Puedo cambiar la hora, el tipo o el ambiente, preparar el mensaje para tu amigo, darte indicaciones o decirte cuándo salir.",
        ),
      };
    case "directions": {
      const you = card?.legs.find((x) => x.who === "you")?.minutes;
      return {
        action: "directions",
        detail: `Directions: highlighted${name ? ` for ${name}` : ""}`,
        reply: name
          ? T(`Tap "Directions" to open the route to ${name} in Google Maps${you != null ? ` (about ${you} min for you)` : ""}.`, `Tocca "Directions" per aprire il percorso fino a ${name} in Google Maps${you != null ? ` (circa ${you} min per te)` : ""}.`, `Toca "Directions" para abrir la ruta a ${name} en Google Maps${you != null ? ` (unos ${you} min para ti)` : ""}.`)
          : T('Ask for a place first, then tap "Directions".', 'Prima chiedimi un posto, poi tocca "Directions".', 'Primero pídeme un sitio y luego toca "Directions".'),
      };
    }
    case "travel_mode": {
      const legs = (card?.legs ?? []).map((x) => `${x.who === "you" ? T("you", "tu", "tú") : T("them", "l'altra persona", "la otra persona")} ${x.minutes} min`).join(", ");
      const what = intent.mode === "bike" ? T("Cycling times aren't checked yet", "I tempi in bici non li calcolo ancora", "Los tiempos en bici aún no los calculo")
        : intent.mode === "walk" ? T("I only have the TfL times shown (walks included)", "Ho solo i tempi TfL mostrati (a piedi inclusi)", "Solo tengo los tiempos de TfL que ves (a pie incluido)")
        : T("Driving times aren't checked", "I tempi in auto non li calcolo", "Los tiempos en coche no los calculo");
      return { action: "directions", detail: `Travel mode ${intent.mode}: not checked · TfL times only`, reply: `${what}${legs ? T(`: TfL says ${legs}.`, `: TfL dice ${legs}.`, `: TfL dice ${legs}.`) : "."} ${T('"Directions" opens Google Maps, where you can pick the bike or car.', '"Directions" apre Google Maps, dove puoi scegliere bici o auto.', '"Directions" abre Google Maps, donde puedes elegir bici o coche.')}` };
    }
    case "weather": {
      const w = factOf(card, /^Weather$/)?.value ?? result?.steps?.find((s) => s.id === "weather" && s.status === "done")?.detail;
      return { detail: w ? "Weather: from the plan's Open-Meteo forecast" : "Weather: no forecast on this plan", reply: w ? T(`Forecast (Open-Meteo): ${w}.`, `Previsioni (Open-Meteo): ${w}.`, `Previsión (Open-Meteo): ${w}.`) : T("I don't have a forecast for this plan.", "Non ho le previsioni per questo piano.", "No tengo la previsión para este plan.") };
    }
    case "step_free": {
      const f = factOf(card, /^Step-free$/);
      const known = f && f.verdict !== "unknown";
      return {
        detail: known ? "Step-free: from the OSM wheelchair tag" : "Step-free: not tagged",
        reply: known
          ? T(`${name}: ${f!.value}. Station step-free access isn't checked.`, `${name}: ${f!.value.replace("Wheelchair access", "accesso in sedia a rotelle").replace("yes", "sì").replace("limited", "limitato")}. L'accesso senza gradini alle stazioni non lo controllo.`, `${name}: ${f!.value.replace("Wheelchair access", "acceso en silla de ruedas").replace("yes", "sí").replace("limited", "limitado")}. El acceso sin escalones de las estaciones no lo compruebo.`)
          : T(`Step-free access for ${name ?? "this place"} isn't tagged in OpenStreetMap, so I can't say.`, `L'accesso senza gradini di ${name ?? "questo posto"} non è segnato su OpenStreetMap, quindi non lo so.`, `El acceso sin escalones de ${name ?? "este sitio"} no está en OpenStreetMap, así que no lo sé.`) + linkNote(card, l),
      };
    }
    case "price":
      return { detail: "Price: not in our sources", reply: T(`I don't have prices for ${name ?? "this place"}; our sources don't list them.`, `Non ho i prezzi di ${name ?? "questo posto"}: le nostre fonti non li riportano.`, `No tengo precios de ${name ?? "este sitio"}: nuestras fuentes no los dan.`) + linkNote(card, l) };
    case "busy":
      return { detail: "Busyness: no data", reply: T(`I can't see how busy ${name ?? "it"} is; I don't have live crowd data.`, `Non so quanto è affollato ${name ?? "il posto"}: non ho dati sulla gente in tempo reale.`, `No sé cuánta gente hay en ${name ?? "el sitio"}: no tengo datos de afluencia en directo.`) + T(" Ask for \"quieter\" and I'll favour calmer spots.", " Chiedi \"più tranquillo\" e cerco posti più calmi.", " Pide \"más tranquilo\" y busco sitios más calmados.") };
    case "dog":
      return { detail: "Dogs: not in our data", reply: T(`I don't know if ${name ?? "it"} allows dogs; it isn't in our data.`, `Non so se ${name ?? "il posto"} accetta cani: non è nei nostri dati.`, `No sé si ${name ?? "el sitio"} admite perros: no está en nuestros datos.`) + linkNote(card, l) };
    case "wifi":
      return { detail: "Wi-fi/sockets: not in our data", reply: T(`I don't know about wi-fi or sockets at ${name ?? "this place"}; it isn't in our data.`, `Non so se ${name ?? "il posto"} ha wi-fi o prese: non è nei nostri dati.`, `No sé si ${name ?? "el sitio"} tiene wifi o enchufes: no está en nuestros datos.`) + linkNote(card, l) };
    case "book":
      return { detail: "Booking: not supported", reply: T(`I can't book tables.`, `Non posso prenotare tavoli.`, `No puedo reservar mesas.`) + linkNote(card, l) };
    case "call":
      return { detail: "Call: no phone numbers in our data", reply: T(`I don't have ${name ? `${name}'s` : "their"} phone number and I can't call.`, `Non ho il numero di ${name ?? "questo posto"} e non posso chiamare.`, `No tengo el teléfono de ${name ?? "este sitio"} y no puedo llamar.`) + linkNote(card, l) };
  }
}

/** Friendlier "didn't catch that" for a follow-up nothing understood (localised for plainly Italian/Spanish text). */
export function fallbackReply(raw: string, top?: string): string {
  const l = chatLang(raw);
  return ({
    en: `Sorry, I didn't catch that${top ? ` for ${top}` : ""}: try a time ("8pm"), a type ("a pub"), "quieter", "send it to my friend", "directions" or "when should I leave".`,
    it: `Scusa, non ho capito${top ? ` per ${top}` : ""}: prova un orario ("alle 20"), un tipo ("un pub"), "più tranquillo", "mandalo al mio amico", "indicazioni" o "quando parto".`,
    es: `Perdona, no lo he entendido${top ? ` para ${top}` : ""}: prueba una hora ("a las 20"), un tipo ("un bar"), "más tranquilo", "envíaselo a mi amigo", "cómo llego" o "cuándo salgo".`,
  })[l];
}
