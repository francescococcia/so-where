# So where? · 3-minute demo script

Live: https://so-where.vercel.app · Every step uses only Encode-built features.
Persona: **you** (Francesco) are at **Old Street**; your friend **Sam** is in **Brixton**.

## Warm-up checklist (T-15 min)

- [ ] Open https://so-where.vercel.app in Chrome on the demo laptop. Allow **microphone**, **camera** and **location** once, then reload.
- [ ] Run one warm-up plan ("Friday at 7. I'm at Old Street, my friend is in Brixton. A cosy quiet pub halfway."). This warms the serverless functions and the Atlas query-embedding cache: on M0, Voyage query embeddings are capped at 3 per minute and cached for 15 min. Confirm the steps list shows **"MongoDB Atlas hybrid search · vibe match"** and **"MongoDB Atlas Stream Processing · live line status … as of HH:MM"** with a time from the last minute or two.
- [ ] If the Stream Processing step is missing, the processor `tfl_line_status` on SP2 has stopped. Restart it with `scripts/asp-setup.sh` (see `docs/mongodb-stream.md`), or skip beat 5 and use the backup video.
- [ ] Unmute the voice card (speaker icon on the card). Check the laptop volume. Use headphones or a low speaker volume so the live agent does not hear itself.
- [ ] Have a printed photo or second-screen image of a London landmark (e.g. the Old Royal Naval College) with a person in shot, for the face blur chip.
- [ ] Open backup tabs: `?demo=translate`, `?demo=repick`, `?demo=place-landmark`, `?demo=meet`, and the backup video.
- [ ] Turn on Do Not Disturb. Use a stable connection (phone hotspot as backup).
- [ ] After the finale: **stop the stream processor** (it costs about $0.07/h).

## Script (3:00), word for word

Real inputs only: live voice, live TfL, a real photo. Say the lines in quotes; the bullets are what to show. About 300 spoken words plus the Italian lines, so there is room to breathe while plans load.

### 0:00–0:15 · The problem

Show the home screen: the "Right now in London" strip (live line status from the Atlas stream, weather, today's events, via `/api/now`), the example pins and the *Meet halfway* card. The headline types itself in once on load.

> "This is So where. I'm at Old Street, my friend Sam is in Brixton, and it's Friday night. Picking 'somewhere in the middle' by eye ignores how the Tube actually runs, and search can't tell you what's open at seven."

### 0:15–0:55 · Live voice in Italian → fair middle → Argon checked

Tap the **mic** (the Live voice panel opens: "Voice isn't saved."). Say:

> **"Venerdì alle sette. Io sono a Old Street, la mia amica è a Brixton. Un pub a metà strada."**

While it plans:

> "I'm talking to a Gemini Live agent, in Italian. It turns my ask into a plan call. The planner gets real TfL journey times for both of us from every central hub."

When the cards land, point at the headline "*Borough is the fair middle: you 20 min, them 21*" (live numbers vary) and the **Argon** verify row:

> "Twenty minutes for me, twenty-one for Sam. Gemini 4 Argon picks the pub, but only from places we've already checked. Then plain rules re-check its pick against the opening hours, TfL and the weather. If it fails, Argon picks again. And the agent answers me in Italian."

**Fallback:** `?demo=translate`, then `?demo=repick` for a real re-pick ("Repicked: The Trinity (hours not listed) → The Blue Maid").

### 0:55–1:15 · Compound follow-up, by voice

Still in the live session, say:

> **"A che ora chiude? E a che ora ci consigli di andare?"**

> "Two questions at once. It answers from the card's sourced facts: open until eleven, and seven gives us four hours."

End the live session (**End**).

**Fallback:** type the same text in the bottom box. The reply stays in Italian.

### 1:15–1:55 · The MongoDB moment

Start a new ask (type it):

> **"Friday at 7. I'm at Old Street, my friend is in Brixton. A cosy quiet pub halfway."**

Point at the **Vibe match** chip on a card. Then open **How we got here** (collapsed under the plan, e.g. "10 checks · 8.2 s") and point at three lines:
- "Searched 7,225 venues in **MongoDB Atlas**";
- "**MongoDB Atlas hybrid search · vibe match: cosy, quiet**" with "$rankFusion: $vectorSearch (Automated Embedding, voyage-4) + $search";
- "**MongoDB Atlas Stream Processing · live line status** … as of HH:MM".

> "This is MongoDB at work. Atlas Search finds venues near the middle. For 'cosy and quiet', one rankFusion query fuses vector search and full-text search, and Atlas embeds the venues itself with Voyage 4. And a stream processor pulls TfL line status into Atlas every minute. If a line is down, the journey gets longer and the card says 'rerouted'."

**Optional Atlas UI cut (5–8 s, recorded separately):** Atlas → Data Explorer → `sowhere.line_status`, refresh once so `updatedAt` changes; then Atlas Search → `venues_vector` index (vector, autoEmbed voyage-4). Close the steps panel again.

**Fallback:** none as a link. Use the backup video.

### 1:55–2:30 · Snap a real place

Tap the camera icon → **Snap a place** → photograph the printed or on-screen landmark (with a person in shot).

Point at the **"Faces blurred · 1"** chip, the certainty level and the "*Why here*" line, then tap **Meet here**.

> "Or just take a photo. Faces are blurred on the phone, before anything is uploaded. Argon reads the sign, and it tells me how sure it is. Meet here, and that becomes the plan."

**Fallback:** `?demo=place-landmark` (labelled Example data, no face chip; say the face blur line anyway).

### 2:30–2:42 · It never sends for you

Tap **Send plan**. Point at "*Nothing is sent from here. Their area is never included.*" and **Copy text** / **Share**.

> "It writes the message. I send it. Sam's location is rounded to about five hundred metres and never stored."

**Fallback:** `?demo=meet` → **Send plan**.

### 2:42–3:00 · Close

Back on the plan, with the map in shot.

> "Three Gemini agents: a planner that picks and gets checked, a live voice agent, and a translator. Six MongoDB Atlas features. Every fact has a source, and what it couldn't check, it says. So where? Fair, checked, and honest."

## Demo links (checked against production 7323b86, 25 Oct 08:0x London)

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
| 0–4 s | Title card: "So where? Old Street ↔ Brixton." |
| 4–10 s | Italian voice ask → headline "fair middle" + **Argon verified** row (zoom in) |
| 10–13 s | Live agent answering in Italian; voice card with the "Italiano · translated by Gemini" chip |
| 13–17 s | Compound follow-up answered |
| 17–22 s | "Cosy quiet pub" → **Vibe match** chip → steps: **Atlas hybrid search** + **Atlas Stream Processing · live line status** (zoom in on the MongoDB lines) |
| 22–27 s | Snap a landmark → **Faces blurred** chip → **Meet here** |
| 27–30 s | **Send plan** dialog: "Nothing is sent from here." End card with the URL |
