# So where? · 3-minute demo script

Live: https://so-where.vercel.app · Every step uses only Encode-built features.
Persona: **Maya** is at **Old Street**; her friend **Sam** is in **Brixton**.

## Warm-up checklist (T-15 min)

- [ ] Open https://so-where.vercel.app in Chrome on the demo laptop. Allow **microphone**, **camera** and **location** once, then reload.
- [ ] Run one warm-up plan ("Friday at 7. I'm at Old Street, my friend is in Brixton. A cosy quiet pub halfway."). This warms the serverless functions and the Atlas query-embedding cache: on M0, Voyage query embeddings are capped at 3 per minute and cached for 15 min. Confirm the steps list shows **"MongoDB Atlas hybrid search · vibe match"** and **"MongoDB Atlas Stream Processing · live line status … as of HH:MM"** with a time from the last minute or two.
- [ ] If the Stream Processing step is missing, the processor `tfl_line_status` on SP2 has stopped. Restart it with `scripts/asp-setup.sh` (see `docs/mongodb-stream.md`), or skip beat 5 and use the backup video.
- [ ] Unmute the voice card (speaker icon on the card). Check the laptop volume.
- [ ] Have a printed photo or second-screen image of a London landmark (e.g. the Old Royal Naval College) with a person in shot, for the face blur chip.
- [ ] Open backup tabs: `?demo=translate`, `?demo=repick`, `?demo=place-landmark`, `?demo=meet`, and the backup video.
- [ ] Turn on Do Not Disturb. Use a stable connection (phone hotspot as backup).
- [ ] After the finale: **stop the stream processor** (it costs about $0.07/h).

## Script (3:00)

### 0:00–0:15 · The problem

> "This is Maya. She's at Old Street, her friend Sam is in Brixton, and it's Friday night. 'Somewhere in the middle' by eye ignores how the Tube really runs. Search doesn't know what's open at 7, or that a line is down. So where? does."

### 0:15–0:50 · Italian voice ask → fair middle + Argon verify

Tap the **mic** and say in Italian:

> **"Venerdì alle sette. Io sono a Old Street, la mia amica è a Brixton. Un pub a metà strada."**

Point at:
- the headline "*Borough is the fair middle: you 20 min, them 21*" (live numbers will vary);
- the **Argon verified** row: "*open until 23:00 · fair split · N options checked*".

> "Gemini 4 Argon picks, but only from places we've already checked. Then rules re-check its pick against opening hours, TfL and the weather. If the pick fails, Argon has to pick again."

**Fallback:** `?demo=translate` (Italian ask, offline). Then `?demo=repick` to show a real re-pick ("Repicked: The Trinity (hours not listed) → The Blue Maid").

### 0:50–1:05 · Voice card

Let the **voice card** speak (in Italian, because the ask was in Italian). Point at the "*Italiano · translated by gemini-3.5-flash-lite*" chip.

**Fallback:** `?demo=translate` shows the same card. Press the replay icon.

### 1:05–1:25 · Compound follow-up

Type (or say) in the bottom box:

> **"A che ora chiude? E a che ora ci consigli di andare?"**  (English also works: "What time do they close? And what time do you recommend?")

The reply stays in Italian, because the conversation is in Italian. Checked live: it answered "è aperto fino alle 23:00 … l'orario delle 19:00 del vostro piano va bene, con 4 ore prima della chiusura".

> "Two questions in one message, and both get answered from sourced facts."

**Fallback:** none as a link. Use the backup video.

### 1:25–1:50 · Vibe ask → Vibe match + Atlas hybrid

Start a new ask (type it):

> **"Friday at 7. I'm at Old Street, my friend is in Brixton. A cosy quiet pub halfway."**

Point at:
- the **Vibe match** chip on the cards;
- open **How we got here** and show "**MongoDB Atlas hybrid search · vibe match: cosy, quiet**", "$rankFusion: $vectorSearch (Automated Embedding, voyage-4) + $search".

> "Atlas fuses vector search and full-text search in one query, and Atlas embeds the venues itself with Voyage 4."

**Fallback:** none as a link. Use the backup video.

### 1:50–2:05 · Live line status (Stream Processing)

Point at the **line chip** top right ("*Northern · Victoria · Lines running well*"), then the step "**MongoDB Atlas Stream Processing · live line status · streamed every 60 s, as of HH:MM**".

> "An Atlas stream processor pulls TfL line status every minute into MongoDB. If a line is disrupted, journey times go up and the card says 'rerouted'."

**Fallback:** none as a link. Use the backup video.

### 2:05–2:30 · Snap a landmark → face blur → Meet here

Tap **Snap a place** → camera → photograph the landmark image (with a person in shot).

Point at:
- the **"Faces blurred · 1"** chip ("blurred on this device, before upload");
- the certainty level;
- the "*Why here*" line.

Tap **Meet here**.

**Fallback:** `?demo=place-landmark` (University of Greenwich, "Why here", **Meet here**; labelled Example data). There is no face chip in the canned demo, so say it aloud.

### 2:30–2:40 · Send never auto-sends

Tap **Send plan**. Point at "*Nothing is sent from here. Their area is never included.*" and the **Copy text** / **Share** buttons.

> "It drafts; you send. Sam's location is rounded to about 500 metres and never stored."

**Fallback:** `?demo=meet` → **Send plan**.

### 2:40–3:00 · Semi-controlled finale

> "Judges, pick any two London stations and a vibe."

Type: **"Friday at 7. I'm at ⟨station A⟩, my friend is at ⟨station B⟩. A ⟨vibe⟩ place halfway."** Read out the fair middle and the Argon line.

If the plan is slow or fails, say "this is live TfL data". Then switch to `?demo=meet` and close with:

> "Fair, checked, and honest about what it couldn't check."

## Demo links (all checked against production 7323b86, 25 Oct 08:0x London)

| Link | Shows |
|---|---|
| `?demo=meet` | Meet-halfway plan, labelled Example data |
| `?demo=repick` | Argon re-pick row |
| `?demo=translate` | Italian ask + Italian voice card |
| `?demo=place-landmark` | Landmark snap with Meet here |
| `?demo=place`, `?demo=place-candidates`, `?demo=place-nomatch` | Other snap outcomes |
| `?demo=saturday` | Walk-in "near me" plan |
| `?demo=clarify` | Live: asks "Where's Sam coming from?" |

Not valid (they load the empty home screen, so don't use them): `?demo=place-medium`, `?demo=place-low`, `?demo=vibe`.

## 30-second backup video: shot list

| t | Shot |
|---|---|
| 0–4 s | Title card: "So where? Maya at Old Street, Sam in Brixton." |
| 4–10 s | Italian voice ask → headline "fair middle" + **Argon verified** row (zoom in) |
| 10–13 s | Voice card speaking, with the Italiano chip |
| 13–17 s | Compound follow-up answered |
| 17–22 s | "Cosy quiet pub" → **Vibe match** chip → steps: **Atlas hybrid search** + **Atlas Stream Processing · live line status** (zoom in on the MongoDB lines) |
| 22–27 s | Snap a landmark → **Faces blurred** chip → **Meet here** |
| 27–30 s | **Send plan** dialog: "Nothing is sent from here." End card with the URL |
