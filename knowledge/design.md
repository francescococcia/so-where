# So where? — design notes

> Context loading for the impeccable skill did not run (its launcher script isn't available on this box), so I read the existing project context directly: `globals.css`, `components.json`, `package.json`, and the old mockup and audit.

## Philosophy: "pocket street atlas"
Scandinavian warmth mixed with editorial cartography. Picture a folded London A–Z: warm paper, deep ink, one red you can't miss. The map is the hero. The panel reads like a printed guide with footnotes. Every claim carries its source and time in a small mono font, like a map legend.
- **Do:** warm paper backgrounds, ink text, one red action per screen, pins with a hard "printed" offset shadow, mono source chips, plain sentences.
- **Don't:** purple gradients, glassmorphism, Inter, emoji, more than one accent, decorative animation.
- **State:** server data is the source of truth. The UI only holds the typed ask and the selected card. The other person's location is rounded to about 500 m and never stored.

## Palette (light mode ships; dark is defined but not demoed)
| Token | Hex | Use |
|---|---|---|
| paper | `#F5F0E6` | page, map tint |
| surface | `#FFFDF8` | panel, cards |
| well | `#EDE6D8` | input, quiet chips |
| ink | `#1C2333` | text, selected chip |
| ink-2 / ink-3 | `#4A5163` / `#5F6370` | secondary / tertiary text |
| line / line-strong | `#E2D9C8` / `#C9BDA6` | hairlines / input borders |
| **pillar** (accent) | `#C2402A` (hover `#A9361F`, soft `#FBE4DC`) | primary button, chosen pin |
| canal | `#1D5C85` | routes, links, focus ring |
| park (confirmed) | `#23623F` on `#DCEFE2` | "Confirmed" chip |
| amber (likely) | `#7F5200` on `#FBEBC8` | "Likely" / forecast chip |
| slate (unknown) | `#555B69` on `#ECE7DD` | "Unknown" chip |
| highlighter | `#F2C230` | "you" pin, fair-middle halo, text highlight (never text colour) |

WCAG check (script, Sat 24 Oct): ink on paper 13.8:1 · ink-2 7.0 · ink-3 5.3 (4.8 on well) · white on pillar 5.2 · pillar text on surface 5.1 · canal 7.1 · verdict chips 5.5–6.1. All AA for normal text.

## Type (next/font/google)
- **Bricolage Grotesque** (700/800) — display: wordmark, answer headline, card titles. `variable: "--font-bricolage"`
- **Instrument Sans** (400–700) — body and UI. `variable: "--font-instrument"`
- **IBM Plex Mono** (400/500) — source, "as of" stamps, labels. `variable: "--font-plex-mono"`

```tsx
// src/app/layout.tsx
import { Bricolage_Grotesque, Instrument_Sans, IBM_Plex_Mono } from "next/font/google";
const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500","700","800"], variable: "--font-bricolage" });
const body = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400","500"], variable: "--font-plex-mono" });
// <html className={`${display.variable} ${body.variable} ${mono.variable}`}>
```

## Shape, depth, motion
- Radius: 8 (chips) · 14 (cards, inputs) · 22 (panel). shadcn `--radius: 0.875rem`.
- Shadows are ink-tinted, not black. Pins use a hard 2px offset (`--shadow-pin`).
- Motion: cards settle in with `--easing-out`, 250 ms, 60 ms stagger. Route lines draw in over 900 ms. Pins drop with a small bounce. All of it turns off under `prefers-reduced-motion`.
- Touch targets ≥ 44 px (buttons are 44 px; chips are 32 px tall, so give them 44 px hit areas on mobile).

## Honesty pattern (the core component)
Every fact row = **label · value · mono source + time · verdict chip**.
- **Confirmed** (green): a source states it (OSM tag, TfL status now).
- **Likely** (amber): inferred or a forecast (OSM hours with no check date, "no booking info", weather forecast).
- **Unknown** (slate): no source has it (price, noise, step-free when not tagged). Unknowns are shown, never hidden.

## Deviations from the design-tokens skill
- Dark mode is defined under `[data-theme="dark"]`, but the `prefers-color-scheme` block is left as opt-in. Tonight's demo is light only.
- Chips are 32 px tall on desktop for density (below the 44 px target); mobile must pad them.
- Added verdict tokens (`--verdict-*`) and shadcn variable mapping, which the skill doesn't list.

## Files
- `design-tokens.css` — paste into `src/app/globals.css`
- `index.html` → `mockup.png` (main Plan screen)
- `saturday.html` → `mockup-saturday.png` ("what's on near me, walk-in")
- `base.css` — mockup-only layout CSS
