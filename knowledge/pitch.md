# Lumap Near Me: pitch and demo

Real inputs, checked live on Sat 24 Oct ~18:00 BST from Encode Hub (41 Pitfield St, N1 6DA). **Re-check every number on Sunday morning** and update the lines marked ⟳ before recording.

## 30-second pitch (spoken, no slides)
> "When you arrive somewhere in London, what's happening around you is scattered across TfL, council planning portals, weather apps, air-quality sites and Luma. Nobody checks them all.
> Lumap Near Me puts all that live open data on one map and lets you just ask: 'What's on tonight, and how do I get there step-free without getting soaked?'
> It answers with sources and says plainly when data is missing. And when you find a great spot, take a photo: it blurs faces, strips your location data and drafts a Luma event or a new map entry, but nothing is published until you approve it. Every step is in the action log."

## 3-minute demo script
| Time | Show | Say |
|---|---|---|
| 0:00 | Francesco at Encode Hub (or the named user from plan.md D1) | "I've just arrived in Shoreditch for a weekend. What's going on around me?" |
| 0:10 | Disclosure line on screen | "The base map and chat existed before Encode kickoff; everything you'll see next was built this weekend." |
| 0:20 | Tap "Near me": map fills with layers, briefing card loads, each line with source + time | ⟳ "Three roadworks within about a kilometre, including lane restrictions on Old Street at Vince Street, 300 m away. Over a thousand planning applications within 400 m on the London Datahub; the newest was validated on 13 Oct. Rain likely this afternoon, dry tomorrow. No flood alerts." |
| 0:45 | Ask (voice): "Is anything being built on my street?" | Answer: nearby applications with status and a PLD link. "Every fact has its source and how fresh it is." |
| 1:05 | Ask: "Take me to a tech event tonight, step-free, and I don't want to get wet" | Agent picks a Luma event, calls TfL with step-free on, checks the weather. ⟳ "TfL has no step-free info for Old Street Underground, so it says so and routes via Hoxton Overground, 640 m away, which has lift access." |
| 1:35 | Journey card: step-free vs fastest, rain line, line status | "It's not a chatbot guessing: it's live TfL, Open-Meteo and the action log showing each call." |
| 1:50 | Take a real photo outside the Hub (taken on the day) | Faces blur on screen; "location read, then stripped from the file". |
| 2:05 | Blurry photo first → "Not sure what this is. Can you tell me?" | "It reads messy inputs honestly." |
| 2:15 | Clear photo → "Create an event here" → draft (title, time, address) → **Approve** | Creates a private Luma event (or the copy-block fallback). "Nothing is public until I say so." |
| 2:35 | "Add this place" → OSM note **Approve** + Google Maps "Add a missing place" link | "Google has no API for this, so we hand you the link; OpenStreetMap gets a real note." |
| 2:45 | Action log drawer | "Every tool call, every approval, every source, logged." |
| 2:55 | Close | "Lumap Near Me: your neighbourhood, live, in plain English." |

## Real inputs checklist (Sunday morning)
- [ ] Re-run the briefing for 51.5287, -0.0838; note the roadworks, planning count, rain % and AQ index
- [ ] Pick tonight's Luma event for the journey (or a Lumap venue if Luma is empty for Sunday)
- [ ] Take 2 real photos outside the Hub: one blurry, one clear; no identifiable faces in the final cut
- [ ] Confirm the Luma path (API with Plus, or fallback) and the OSM target (live or dev server)
- [ ] Cache all responses so the demo works offline
- [ ] Record at 1080p, 3:00 max; backup take
