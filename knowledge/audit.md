# Lumap, revised: "Plan my meetup". Judging-panel re-audit
Encode London 2026 · audited Sat 24 Oct 2026, 18:40 BST · judged as pitched (not as built) · repo not edited.

Live checks run for this audit (Sat 24 Oct, ~18:33 BST, from the box):
- **TfL Journey Planner, Thu 29 Oct, leaving 18:30.** Old Street → Borough area: 21–24 min. Clapham Common → Borough area: 20–23 min. Both legs are direct on the Northern line, so **Borough is a genuinely fair point**.
- **Pubs near Borough (OSM, via Overpass):**
  - The Blue Maid (173 Borough High St, open Thu 12:00–00:00, no wheelchair tag): you 24 min, her 23 min.
  - George Inn (75–77 Borough High St, `wheelchair=no`, checked May 2026): 28 / 28 min.
  - Bunch of Grapes (2 St Thomas St, `wheelchair=yes`, checked 16 Oct 2026): 26 / 29 min.
- **TfL line status:** Northern Good Service, Jubilee Minor Delays.
- **Open-Meteo:** Thu 19:00 rain probability 0%, as a 5-day forecast. Use the real number in the demo, not an invented "60%".
- **TfL roadworks:** nothing on either route. The nearest is King William St, about 1 km away, severity "Minimal".

## 1. Re-scores (previous → now)

### The Real World (Encode): 66 → **75/100**. Placement: top 3 likely-ish (~40%), win ~15–20%
| Criterion | Score | Reason |
|---|---|---|
| Real-world usefulness | 7 (was 6) | "Where do we meet?" is universal and frequent. The organiser scene keeps a serious user. Who pays is still open. |
| Reads the world | 8 (was 7) | Fair-in-minutes from live TfL, OSM hours and wheelchair tags, live risks and honest "unknown" for price and noise. The photo is now a side act, so perception is thinner. |
| Technical execution | 7 (was 6) | One engine, a clear flow, a kill-switch fallback and an eval. Still big for one person in 17 h, and an Atlas migration overnight is risky. |
| Responsibility | 8 (=) | Her location is used only for the query, rounded and kept out of the message. You still lose a point until it's clear *she* consented to being located (see risks). |

### Agents That Ship (Encode): 63 → **72/100**. Placement: top 3 possible (~30%)
| Criterion | Score | Reason |
|---|---|---|
| End to end | 7 (was 6) | One sentence becomes a ranked plan with routes and a drafted message. The final act (send) is still the human's, which is correct but less "agentic". |
| Reliability | 8 (was 7) | TfL switched off live with a cached fallback, a blurry photo answered "not sure", and confirmed/contradicted/unknown on each claim. This is exactly this rubric. |
| Usefulness | 6 (was 5) | People would use it. Paying is unclear, and free London alternatives exist (see below). |
| Technical depth | 7 (was 6) | Multi-step planning (fair point → candidates → risks → rank), memory in Atlas, and a 10–15 question eval with a pass rate. |
| Safety and control | 8 (=) | No auto-send, approval before the OSM note and Luma page, plus an action log. Add a visible "what I didn't do" line in the log for a 9. |

### MongoDB Atlas: 55 → **70/100**. Placement: top 3 plausible (~35%), depending on the field
| Criterion | Score | Reason |
|---|---|---|
| Atlas is core | 8 (was 5) | The only store for venues, events, readings, price reports and the log. No longer bolted on, if Supabase really only does auth. |
| Breadth of Atlas features | 7 | Geo, Atlas Search with Hybrid Search via `$rankFusion` and Automated Embedding. If Automated Embedding runs on Voyage AI, say so on screen, because it counts. There's no Stream Processing, which is fine. |
| 3-min video showing Mongo | 6 | It's planned. It must show the Atlas UI, the index definitions and a real pipeline result, not just app output. |

> **Tech risk:** check early whether `$geoNear` is allowed inside a `$rankFusion` input pipeline on your cluster tier and version. If it isn't, use `$search` with a `geoWithin`/`near` compound clause plus `$vectorSearch` inside `$rankFusion`. Test this first, before anything else in Atlas.

### Gemini 4 Argon: skipped. The right call (eligibility risk, and it doesn't need Argon).

### Audience vote: 6 → **7/10**
The date hook gets a laugh and instant recognition: everyone has had the "where shall we meet?" WhatsApp. The live "TfL off" moment adds tension. It's not an 8+ because there's no physical or emotional peak like hardware or health. The organiser scene adds weight but costs time.

## 2. Honest risks of the new framing
1. **"Consumer toy" read.** Investors (Emami, Saunders, Al-Zamkan) may file a date-planner under "nice, not a business". Mitigation: open with the date (relatable), then say "the same engine plans for 60" within 20 s, and name the B2B angle.
2. **"Meet halfway" is a crowded, solved-looking niche. Several free tools already do it:**
   - **Halfway London** (halfwaylondon.com): fair London meeting areas for 2–10 people, ranked by TfL timetable journey times, with venues and a last-train check. This is the closest competitor, and a judge may know it. Its times are *precomputed* for typical evening service, then it asks TfL live for the chosen route.
   - **Fair Meet LDN** (fairmeetldn.com): fairest station by real TfL times, plus nearby pubs and cafés, and purpose filters.
   - **CityMeet** (citymeet.co.uk): up to 3 postcodes, public-transport times, top venues.
   - **Whatshalfway** (whatshalfway.com, iOS app): worldwide halfway by time or distance, emails directions to everyone. Mostly road trips.
   - **Meetways**: a mobile-friendly midpoint website.
   - **Google Maps and Citymapper:** journeys for one person at a time, with no fairness and no honesty about gaps.

   **So never claim "fair in minutes" as the novelty.** Lumap's honest difference:
   - *Tonight's* live risks for the chosen place and both routes: disruptions, works, rain, crowd-making event clashes and planning next door.
   - A verdict on every claim (confirmed, contradicted or unknown), with source and "as of".
   - Accessibility from OSM tags, with honest "not tagged".
   - Price honesty, plus price reports from people stored in Atlas.
   - **Write-back to the commons:** OSM notes and a Luma draft.
   - **The same engine for organisers of 60.**

   Say this in one line: *"Others find the middle. Lumap tells you what will go wrong there tonight, and what it doesn't know."*
3. **Privacy of a third party's location.** You are geolocating "her" without her in the loop. Mitigations to show:
   - Accept only an **area or station**, never an address.
   - Round it to about 500 m.
   - Keep it in memory only, never in Atlas, never in the message.
   - Optionally, a "send her a link to add her own area" flow.

   Say it out loud, because the Penelope Health judges will weigh consent.
4. **Who pays?** This is still unanswered. Honest options:
   - (a) B2B API or widget for dating and community apps. "Where should we meet?" is a known drop-off point after a match.
   - (b) An organiser tier for community and event hosts: venue shortlist, accessibility, Luma draft.
   - (c) **Not** paid venue placement, which would break the honesty story. Say so.

   Claim no traction you don't have.
5. **Scope, still.** Two scenes plus photo, OSM write-back, the Luma draft, an Atlas migration, the eval and the kill switch is too much for about 17 h solo.
   - Scene 1 is the product.
   - Scene 2 should be ≤40 s in the video, and the photo/OSM part can drop to a recorded clip.
   - If Atlas isn't the sole store by Sun 08:00 GMT, the MongoDB bounty is at risk.

## 3. "Why it fits": criterion → demo moment
| Challenge · criterion | Exact demo moment or feature that earns it |
|---|---|
| Real World · usefulness | The opening line: "Date Thursday at 7, Old Street and Clapham, pub halfway, £40, quiet". Then the switch to "60 people, step-free" for the organiser. |
| Real World · reads the world | Borough chosen by *TfL travel time* (24 vs 23 min), not geometry. OSM hours and wheelchair tags per pub. Live Northern line status. Rain at 19:00 from Open-Meteo. |
| Real World · messy inputs and data gaps | "Price: unknown", "Quiet: unknown", "Step-free: not tagged". A blurry photo gets "not sure". No TfL step-free data at Old Street, so it suggests Hoxton (lifts). |
| Real World · technical execution | One sentence → TfL Journey ×6 → OSM candidates → risk tools → ranked top 3 on the map, live in under 3 min of video. |
| Real World · responsibility | Her area rounded to about 500 m, not stored, kept out of the message. Faces and plates blurred, EXIF stripped. Source + "as of" on every chip. |
| Agents · end to end | From the prompt to a drafted "Send her this plan" message with routes, with no follow-up questions needed. |
| Agents · reliability | TfL switched off on stage → "cached 18:33" label. Claims marked confirmed/contradicted/unknown. Eval pass rate [X/15] in the README. |
| Agents · usefulness | Replaces the 20-message "where shall we meet" thread. The organiser venue shortlist plus Luma draft. |
| Agents · technical depth | Planner steps visible in the action log: fair point → candidates → risks → rank → draft. Atlas memory (readings, price reports). The eval set. |
| Agents · safety and control | No auto-send. Approve buttons on the OSM note and Luma page. The action log lists every tool call and every "asked first". |
| MongoDB · Atlas core | All venues, events, readings, price reports and the log live in Atlas. The cache that saves the "TfL off" moment *is* Atlas. |
| MongoDB · features | Geo query plus `$rankFusion` hybrid ("quiet pub like the Blue Maid") with Automated Embedding, shown in the Atlas UI. |
| Audience | The live crowd question "Where would *you* meet?", then the reveal. The TfL kill switch. |

## 4. Top 5 changes for the remaining hours
| # | Change | Gain | Effort |
|---|---|---|---|
| 1 | Lock scene 1 end to end on real inputs before anything else, including the kill switch and cached fallback from Atlas. | +5 Real World, +5 Agents | M |
| 2 | Atlas query spike first (geo + `$rankFusion` + Automated Embedding) on the venue collection. Decide go/no-go by Sun 08:00 GMT. | +8 MongoDB (or saves wasted hours) | M |
| 3 | An eval of 12 questions with ground truth taken from the live APIs. Show the pass rate and one *failure* honestly. | +3 Agents, +2 Real World | S |
| 4 | One differentiator line plus a competitor slide-free mention: "Halfway London finds the middle. We tell you what breaks there tonight." | +3 Real World usefulness, protects against "already exists" | S |
| 5 | Consent UX: "her area" as a station or area only, plus an optional link for her to add her own. | +2 Real World responsibility, judge goodwill | S |

## 5. Verdict
The revised Lumap is a much stronger, more focused entry. It is a clear contender for the top 3 in The Real World and credible in Agents and MongoDB, *if* scene 1 is flawless live and the pitch admits that "meet halfway" already exists and owns "tonight's risks plus honest gaps" as the edge.
