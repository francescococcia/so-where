# Encode London Hackathon 2026 — Knowledge Base

> Source of truth for this repo. Project: **TBD**.
> Sources: the challenge briefs from the Encode Club dashboard (pasted by Francesco on 24 Oct 2026) and the Luma event page (https://luma.com/encode-london-2026, fetched 24 Oct 2026).
> **TBC** = not confirmed from any source I could read. The Encode dashboard needs a login, so I couldn't read it directly.
> All times are London time (BST, UTC+1).

---

## ⏱️ Now / next (quick reminders)

- [ ] **Code freeze / submission deadline: TBC**. Luma only says "Sunday 25 Oct: final build & submissions". Ask at the help desk or check the dashboard, then write the time here: `__:__`
- [ ] Remind yourself 40 min before the deadline (feature freeze), 20 min before (backup video + submission draft) and 10 min before (submit).
- [ ] Collect your credits if you haven't yet: Gemini credits (Google DeepMind team), the $100 MongoDB Atlas credit (MongoDB booth, ground floor) and the $20 Treg credits.
- [ ] Demo has to run in **under 3 minutes** with real inputs.
- [ ] Only code written during the hackathon can be shown in the demo.

---

## 1. Event overview

| Item | Detail | Status |
|---|---|---|
| Event | Encode London Hackathon 2026 (Encode Club) | Confirmed (Luma) |
| Dates | Fri 23 Oct to Sun 25 Oct 2026 ("a full 3 days of non-stop hacking") | Confirmed (Luma) |
| Venue | **Encode Hub**, 41 Pitfield St, London N1 6DA, UK (Shoreditch) | Confirmed (Luma) |
| Hacking began | Fri 23 Oct, 5:00pm | Confirmed (Luma, marked "provisional") |
| Code freeze | **TBC** | Not found |
| Submission deadline | **TBC**: Sunday 25 Oct ("Final build & submissions"), time not given | Partly confirmed |
| Demos and judging | Sunday 25 Oct, time **TBC** | Partly confirmed |
| Event ends | Sun 25 Oct, 4:30pm (awards & closing) | Confirmed (Luma, provisional) |
| Submission platform | Encode London platform page / dashboard: https://www.encodeclub.com/my-programmes/encode-london-2026 | Login needed |
| Team size limits | **TBC** | Not found |
| Extra perk | $20 of **Treg** credits for every builder | Confirmed (Luma) |
| Sponsorship contact | katerina@encode.club | Confirmed (Luma) |

Luma lists **two open challenges** (The Real World, Agents That Ship) and **partner bounties** from Saint, MongoDB and Google DeepMind. It also says "more prizes and judges will be announced soon". **Judges: TBC.**

### Schedule (Luma says "timings are provisional")

**Friday 23 Oct**
- 12:00pm Doors open
- 2:00pm Welcome & opening
- 2:30pm Google DeepMind workshop: Build with Gemini
- 3:00pm Arc workshop with Blessing Adesiji (Circle)
- 3:30pm MongoDB workshop with Robin Varghese and Maja Brlek: Stop Stitching, Start Building
- 4:00pm Saint workshop with Anthony Beaumont
- 4:30pm Challenges & team formation
- 5:00pm Hacking begins
- 6:00pm Saint check-in, to sign up for the Saint bounty (from the Saint brief)

**Saturday 24 Oct (today)**
- Build, learn & collaborate, with mentoring through the day
- Talks and discussions (provisional)
- Project development
- Morning: Saint agents set up for the 10 selected teams (from the Saint brief)

**Sunday 25 Oct**
- Final build & submissions (time **TBC**)
- Demos & judging (time **TBC**)
- Awards & closing (event ends 4:30pm)

### ⚠️ Conflicts between sources
- **MongoDB prize:** the dashboard brief says "Prizes: To be announced". Luma says "**£6,800 in cash prizes**". Confirm onsite.
- **Gemini prize:** the dashboard says "$15,000 in Gemini API / Google Cloud credits" (then lists Gemini API credits per place). Luma says "$15,000 in Gemini API credits".

---

## 2. Challenge: Build with Gemini 4 Argon (`gemini-4-argon`): Autonomous Agents & Multimodal Applications

**Sponsor:** Google DeepMind · **Prize pool:** $15,000

### Summary
Build a working application or autonomous agent powered by **Gemini 4 Argon** (`gemini-4-argon`) that solves a specific problem for **a real person you can name**. Argon is Google DeepMind's new frontier model for software engineering, complex knowledge work, cybersecurity defence and multimodal creation. It unifies input, reasoning and output in a single **1M-token context window**, works longer on its own, keeps context across large codebases and dense document sets, and can act as the lead orchestrator for Antigravity Managed Agents and fast companion models (parallel subagents, real-time voice and vision, image/video/music generation, on-device open models).

**The challenge:** build and demo a working project that **could only be built with Gemini 4 Argon** and Google DeepMind's latest model toolkit. Any domain is allowed, including Encode London's themes:

**Pathway 1: Autonomous Agents That Ship** (software engineering, cybersecurity, complex workflows)
Build an agent that plans, uses tools, **verifies its own output against a concrete pass/fail signal** (test suites, compiler output, runtime logs or headless browser checks) and finishes multi-step work end to end. Use `gemini-4-argon` (thinking_level `"medium"` or `"high"`, long decode with `background=True`) or a Google-hosted Linux sandbox with `antigravity-preview-09-2026`.

**Pathway 2: The Real World, Hard Tech & Multimodal Creation** (voice, video, 3D/WebGPU, physical systems)
Build an app that perceives, simulates or creates across real-world video, live voice, spatial 3D/WebGPU environments, or hardware and scientific data, using `gemini-4-argon` and companion models.

### Ideas
- Pathway 1: a **self-healing security and dependency migration agent** that reproduces a vulnerability in an Antigravity sandbox, patches it and outputs a visual diff walkthrough.
- Pathway 1: a **legacy codebase modernizer** that rebuilds a tested modern web app from an old app and a screen recording.
- Pathway 1: a **research-to-prototype system** where Argon coordinates the Deep Research agent and delegates modules to `gemini-3.8-flash` subagents.
- Pathway 2: a **playable Three.js/WebGPU world** where Argon computes the physics or level geometry, `gemini-3.8-live` handles voice interaction and `lyria-3.5` drives the soundtrack.
- Pathway 2: a **manufacturing or lab root-cause analyst** that scrubs inspection footage alongside sensor CSVs and long datasheets.
- Pathway 2: a **hands-free voice and screen navigator in 70+ languages**, with human confirmation before any form is submitted.

### Requirements / projects to avoid (disqualified or low-scoring)
- ❌ A basic chat wrapper, or a simple Q&A bot over a single PDF.
- ❌ A static page with no autonomous reasoning, verification loop or multimodal workflow.
- ❌ An unverified medical diagnosis, mental health counselling or financial advice bot without human-in-the-loop safeguards.
- ❌ Anything built before kickoff. Open-source libraries and starter templates are fine, but **the demo must only show code written during the hackathon**.

### Judging criteria (3-minute live demo + 2 minutes of Q&A; working demos, not slide decks)
| Weight | Criterion | What judges ask |
|---|---|---|
| **50%** | Working live demo | Does it run live with real inputs in under 3 minutes? Did the team use `gemini-4-argon`, Managed Agents or companion models effectively, with a real verification loop? |
| **25%** | Problem and usefulness | Does it solve a concrete problem for a specific person you can name? Could it grow into a product or open-source tool people use after the hackathon? |
| **15%** | Originality / needs Gemini 4 Argon | Is it only possible because of Argon's 1M unified context, long decode, frontier reasoning, agentic video analysis, 3D/WebGPU generation or multi-agent orchestration? Does it keep people in control of actions that affect external systems, money or private data? |
| **10%** | Clarity of pitch | Did the team show who the user is and demo the working product clearly in 3 minutes, without slides? |

### Prizes ($15,000 in Gemini API / Google Cloud credits)
- 🥇 1st: $7,000 in Gemini API credits
- 🥈 2nd: $5,000 in Gemini API credits
- 🥉 3rd: $3,000 in Gemini API credits

### Submission requirements
- [ ] A GitHub repository
- [ ] A 3-minute demo video
- [ ] A live demo for the judges
- [ ] A statement of **which Gemini models and agents you used, and how**

### Who it's for
Builders of all levels, from first-time makers prototyping full-stack apps in Google AI Studio Build and Google Antigravity, to AI and systems engineers building autonomous multi-agent workflows with the Interactions API.

### Toolkit: models
| Role | Model(s) |
|---|---|
| Lead reasoning, coding, 3D/WebGPU, orchestration | `gemini-4-argon` |
| Autonomous sandbox execution (Antigravity Managed Agent) | `antigravity-preview-09-2026` |
| Fast parallel subagents and routing | `gemini-3.8-flash`, `gemini-3.5-flash-lite` |
| Deep web research with citations | `deep-research-preview-04-2026` |
| Real-time voice, camera, transcription, translation | `gemini-3.8-live`, `gemini-3.8-live-extended-thinking`, `gemini-3.5-transcribe-live`, `gemini-3.5-live-translate-preview`, `gemini-3.8-flash-tts` |
| Images, video with sound, music | `gemini-nano-banana-2.1`, `gemini-omni-1.1-flash`, `lyria-3.5` |
| Open models, cloud or on-device | `gemma-4-31b-it` (plus the local E2B and E4B sizes) |

### Toolkit: SDK, API and commands
- Official Gemini SDKs, **version 2.3.0 or later**:
  - Python: `pip install -U "google-genai>=2.3.0"`
  - TypeScript/JavaScript: `npm install @google/genai@latest`
- Recommended endpoint: the **Interactions API**, `client.interactions.create`. It covers models and managed agents, keeps server-side state and supports long background runs.
- Gemini API skills for your coding agent, so it writes current Argon and Interactions API code:
  - `npx skills add google-gemini/gemini-skills --skill gemini-api-dev`
  - `npx skills add google-gemini/gemini-skills --skill gemini-live-api-dev`
  - In Antigravity: `agy plugin install https://github.com/google-gemini/gemini-skills`
- Or prototype directly in **Google AI Studio Build** or **Google Antigravity**.

### Argon API rules ⚠️
- Use `thinking_level` (`"low"`, `"medium"` (the default) or `"high"`). `thinking_budget` is **deprecated**.
- **Remove** `temperature`, `top_p`, `top_k` and explicit `cached_content`. Implicit caching is automatic.
- Set `background=True` to generate past **65,536 tokens** (up to 1M).

### Get started in 15 minutes
1. Claim your credits: collect your pre-provisioned account or Gemini API credits from the Google DeepMind team (handed out at kickoff).
2. Install the Gemini API skills in your coding agent (commands above).
3. Check the Argon API rules (above).
4. Ask the mentors when you're blocked.

### Workshop
**Build with Gemini 4 Argon: Autonomous Agents, Long-Horizon Coding & Multimodal Apps**, Fri 23 Oct, 2:30pm (already held). A 30-minute practical session on Argon's 1M-token context and long decode, autonomous coding and verification loops with Antigravity Managed Agents, multi-agent and multimodal orchestration, plus a live Q&A and bounty walkthrough, including how to claim credits and structure the 3-minute demo.

### Contacts / mentors
- **Amit Vadi** and **Geneviève Huskens**, Google DeepMind mentors at the Google DeepMind booth. Ask them whenever you hit a blocker.
- Feedback (what worked, what broke, what you wish existed): in person, or gemini-developer-feedback@google.com

### Resources (named in the brief; URLs not given, so **TBC**)
Gemini 4 Argon developer guide · Gemini 4 Argon interactive showcase · Google AI Studio and AI Studio Build · Google Antigravity · Gemini API skills for coding agents (https://github.com/google-gemini/gemini-skills) · Gemini API documentation and cookbook · Live API starter apps

---

## 3. Challenge: Build Anything, Change Everything with MongoDB Atlas

**Sponsor:** MongoDB · **Prize:** "To be announced" (dashboard). Luma says **£6,800 in cash prizes**, so confirm onsite.

### Summary
Modern applications need a database that adapts as fast as developers build. MongoDB Atlas is a general-purpose developer data platform, so you can focus on features rather than managing data. It powers everything from simple web apps to complex real-time AI solutions, with one unified developer experience for any data requirement.

**The challenge:** build an innovative application that solves a real-world problem, with **MongoDB Atlas as its foundational backend data store**.

### Requirements
- The app **must rely on a MongoDB Atlas database for its core functionality**.
- Use **at least one** of the Atlas features below. **The more you use, the more points you get:**
  - [ ] Atlas Search (text search)
  - [ ] Atlas Vector Search
  - [ ] Hybrid Search
  - [ ] Automated Embedding
  - [ ] Atlas Stream Processing
  - [ ] Voyage AI by MongoDB models (some are already part of Automated Embedding)

### Ideas
None given in the brief beyond "solve a real-world problem".

### Judging criteria
No weights given. The only scoring rule stated is that **more Atlas features = more points**. Full criteria **TBC**.

### Who it's for
- Skill level: at least beginner in any backend or full-stack language.
- Languages: C, C++, C#, Go, Java, Kotlin, Node.js, PHP, Python, Ruby, Rust or Scala.
- AI tools: use any you like.

### Credits and setup
- Every participant can collect a **$100 MongoDB Atlas credit** from the **MongoDB booth on the ground floor of the Encode Hub**.
- To save time: sign up to MongoDB Atlas, open your account and prepare a cluster in advance.

### Prizes
To be announced (dashboard). Luma: £6,800 in cash prizes.

### Submission requirements
- [ ] A GitHub repository
- [ ] A 3-minute demo video showing the app in action **and MongoDB in use**

### Workshop
**Stop Stitching, Start Building: Simplify Your Data Stack with MongoDB Atlas**, Fri 23 Oct, 3:30pm (already held), with Robin Varghese and Maja Brlek (speakers per Luma). It covered using Atlas as one platform for full-text search, automated embedding, vector search and native reranking, instead of stitching together separate databases, search engines, vector stores and streaming pipelines, plus architecture tips and code patterns. Slides: "Download the workshop slides (PDF)" on the dashboard (URL **TBC**).

### Contacts / mentors
Robin Varghese and Maja Brlek (workshop speakers, per Luma). MongoDB booth, ground floor, Encode Hub.

### Helpful links (named in the brief; URLs **TBC** unless shown)
- MongoDB workshop slides (PDF): the deck from Friday's workshop
- MongoDB Documentation: use the **"Ask MongoDB AI"** feature for specific features
- MongoDB AI Integrations and Partners: agent frameworks, AI platforms, ETL pipelines and other tools
- Build AI Agents with MongoDB
- MongoDB Vector Search Quick Start Tutorial
- MongoDB for Startups (if you're building a startup)

---

## 4. Challenge: 😇 Best Use of Saint AI Agent

**Sponsor:** Saint · **Prize:** £200 cash + Saints + 3 months free

### Summary
Organisers want the coolest thing built with a Saint AI agent. Saint is an AI colleague that works inside real email, calendars, documents, browsers and terminals. You give it a job in plain English, it gets on with it, then tells you what it did and **asks before anything risky**.

**Access:** teams going for this bounty get their own Saint for the whole hackathon. **Only 10 teams** get one, set up on **Saturday morning**. Teams had to sign up at the **Friday 6pm check-in**, and only if serious about building with it. ⚠️ If you didn't sign up on Friday, check whether there's still a slot (**TBC**).

### Already rigged up at the Encode Hub (this is the bar: "go weirder, more useful, or both")
- **Hub radio:** Saint runs the Hub's Sonos and writes songs about members.
- **Snack restocks:** connected to Amazon and Costco, it orders snacks and supplies based on the Hub's inventory.
- **The front door:** it opens the Hub door from a WhatsApp chat.

### The challenge (pick one)
1. **Reverse-engineer something cool:** hook Saint up to a device, app or system that was never meant to have an AI agent, and make it do something useful.
2. **Build something super cool with Saint:** a system that helps run the Hub (or any space, team or community), or a tool that makes Saint more powerful.
3. **Dream up a business:** a business idea, showing Saint running or growing it, with Saint actually doing the work in the demo.

### Ideas to steal
- A Hub concierge that books meeting rooms, greets visitors and lets guests in.
- Lights, heating or screens that react to who's in the building and what's on.
- An events agent that plans a meetup, sends the invites, orders the food and chases RSVPs.
- A Saint that runs a small business's back office: invoices, stock, suppliers and customer replies.
- Plugging Saint into a smart device, a game or an old piece of hardware nobody thought could talk to an AI.

### Judging ("What we're looking for", no weights given)
- **Cool factor:** would people crowd round to watch it?
- **Working proof:** Saint actually doing the job in the demo, live or recorded, with the **before and after**.
- **Real-world use:** would it still be running on Monday?
- **Human control:** what Saint does on its own, and where it stops and asks first.

### Prize (one prize, not a pool)
- £200 cash for the winning team
- A Saint for each member of the winning team
- 3 months of Saint free, for the team to keep using
- A set-up call to get their Saints running

### Submission requirements
- [ ] A **2–4-minute demo** of Saint doing the thing, end to end
- [ ] A short note on **what you asked it to do**, and **which tools, devices and accounts it used**

### Workshop
Saint workshop with **Anthony Beaumont**, Fri 23 Oct, 4:00pm (per Luma; already held).

### Contacts
Anthony Beaumont (workshop speaker, per Luma). Other contacts **TBC**.

### Links
None given (**TBC**).

---

## 5. Challenge: The Real World: AI that understands the world around us

**Sponsor:** Encode Club (open challenge) · **Prize:** **TBC** (not stated)

### Summary
Build software that makes sense of the physical world from **photos, audio, maps and open data**. Most AI still lives in a chat window; this challenge takes it outside, to streets, venues, parks, trails, wildlife, the weather and the air we breathe. Combine vision, audio and language models with maps and public datasets to help people **understand, navigate or look after** the world around them.

### Ideas (starting points, not tracks)
- **Accessibility guide:** describe a street, station or venue from photos (step-free access, entrances, signage, seating, noise) for blind and partially sighted people or wheelchair users.
- **"What's happening near me" explorer:** pull live open data (transport, events, roadworks, planning applications, weather) into one view of a neighbourhood, and answer plain-English questions about it.
- **Trip or hike conditions planner:** combine forecasts, daylight, terrain, trail reports and transport times to say whether, when and how to go.
- **Wildlife and plant ID:** identify species from photos or sound recordings (e.g. bird song) and log sightings on a shared map.
- **City noise or air-quality map:** turn public sensor datasets into a street-level map, a daily briefing or a "quietest, cleanest route" planner.
- **Report it from a photo:** spot potholes, fly-tipping or broken streetlights in a picture and draft the report to the right council team, with the location filled in.
- **Sound-aware assistant:** alert deaf and hard-of-hearing people to sirens, alarms, doorbells or announcements.
- **Label and menu reader:** read a menu, shelf or food label from a photo and flag allergens and dietary needs.
- **Flood and heat risk checker:** explain what an address or route is exposed to, using environmental open data.

### Useful data sources
| Category | Sources |
|---|---|
| Maps and places | OpenStreetMap |
| London data | TfL Unified API, London Datastore |
| Weather | Met Office, Open-Meteo |
| Air quality | Breathe London, London Air Quality Network |
| Flood data | Environment Agency flood-monitoring API |
| Wildlife records | iNaturalist, GBIF |

You can also use any other public data, your own photos and recordings, or hardware such as phone sensors and cameras.

### Judging criteria (no weights given)
- **Real-world usefulness:** a clear user and a problem that exists outside the hackathon.
- **How well it reads the world:** accuracy, and sensible handling of messy inputs (blurry photos, background noise, gaps in the data).
- **Technical execution:** a working end-to-end demo that combines AI models with real data.
- **Responsibility:** respect for privacy (faces, number plates, people's locations), and honesty about uncertainty when the model isn't sure.

### Prizes
**TBC** (not in the brief or on Luma).

### Submission requirements
- [ ] A working demo (web, mobile or hardware)
- [ ] A code repository with a **README and setup instructions**
- [ ] A **2–4-minute demo video** showing it working on **real inputs** (photos, recordings or live data)
- [ ] A short note on the **models and data sources** used

### Workshops / contacts / links
None specific (**TBC**). Data-source URLs weren't given in the brief.

---

## 6. Challenge: Agents That Ship

**Sponsor:** Encode Club (open challenge) · **Prize:** **TBC** (not stated)

### Summary
Build an AI agent that does a **real job end to end**, not just a chatbot. Pick a task someone does today by hand, in a spreadsheet or across ten browser tabs, and build an agent that sees it through: it gathers what it needs, uses real tools, makes decisions, **recovers when something goes wrong** and delivers a finished result. A person stays in control where it matters, **approving the risky steps** rather than doing the work.

### Ideas (any domain welcome)
- **Small-business operations:** chase unpaid invoices, reconcile payments, reorder stock or book suppliers.
- **Recruiting:** screen applications against a brief, shortlist candidates and schedule interviews.
- **Research:** produce a sourced brief, competitor report or due-diligence pack, checking its own claims before handing anything over.
- **Event running:** find a venue, set up the event page, manage sign-ups, send reminders and follow-ups.
- **Developer:** take an issue, write the fix, run the tests and open a pull request ready for review.
- **Personal admin:** renewals, refunds, complaints, forms and appointments.
- **Agents that work together:** agents that hand tasks to each other, or pay and get paid for work (e.g. with stablecoins).

### Judging criteria (no weights given)
- **Does the job:** completes a real task from start to finish with minimal hand-holding.
- **Reliability:** handles errors and edge cases, and knows when to stop and ask a human.
- **Usefulness:** someone would actually use it, or pay for it.
- **Technical depth:** good use of tools, memory, planning and evaluation.
- **Safety and control:** sensible permissions, approval steps for risky actions, and a clear record of what the agent did.

### Prizes
**TBC** (not in the brief or on Luma).

### Submission requirements
- [ ] A working demo of the agent completing its task start to finish (live or recorded)
- [ ] A code repository with a **README and setup instructions**
- [ ] A **2–4-minute demo video**
- [ ] A short description of the **agent's tools, the steps it takes and where a human approves**

### Workshops / contacts / links
None specific (**TBC**).

---

## 7. Comparison table

| Challenge | Sponsor | Prize | Judging focus | Submission format | Demo length |
|---|---|---|---|---|---|
| Gemini 4 Argon | Google DeepMind | $15k credits (7k / 5k / 3k) | Live demo 50%, usefulness 25%, needs-Argon 15%, pitch 10%; verification loop | GitHub repo + 3-min video + live demo + models/agents used | 3-min video; live 3 min + 2 min Q&A |
| MongoDB Atlas | MongoDB | TBA (Luma: £6,800 cash) | Atlas as core data store; more Atlas features = more points | GitHub repo + 3-min video showing MongoDB in use | 3 min |
| Best Use of Saint | Saint | £200 cash + Saints + 3 months free (one winner) | Cool factor, working proof (before/after), Monday-ready, human control | 2–4-min demo + note on prompt, tools, devices and accounts | 2–4 min |
| The Real World | Encode Club | TBC | Usefulness, reading messy real-world input, technical execution, privacy and uncertainty | Working demo + repo (README/setup) + video + models/data note | 2–4 min |
| Agents That Ship | Encode Club | TBC | Does the job end to end, reliability, usefulness, technical depth, safety and control | Working demo + repo (README/setup) + video + tools/steps/approvals note | 2–4 min |

**Common denominator:** a **3-minute** video fits every challenge (3 min exactly for Gemini/MongoDB, within 2–4 for the others).

---

## 8. Overlap and stacking opportunities

Whether you can enter several challenges with one project is **TBC**, so confirm onsite.

Shared themes across all five: **real user + real inputs + end-to-end working demo + human approval for risky actions.**

**Best stack: Gemini + MongoDB + one Encode open challenge**
- Use `gemini-4-argon` as the orchestrator with a **real verification loop**, and MongoDB Atlas as the core store (Vector Search + Atlas Search → Hybrid Search + Automated Embedding/Voyage = more points).
- **+ Agents That Ship** (= Gemini Pathway 1): e.g. a research/due-diligence agent that stores sources in Atlas, uses hybrid search to check its own claims, and asks for approval before sending. Or a small-business back-office agent (invoices/stock) with an approval queue and an action log stored in MongoDB.
- **+ The Real World** (= Gemini Pathway 2): e.g. "Report it from a photo" or an accessibility guide. Gemini vision/live models + London open data (TfL, Open-Meteo, Environment Agency) + Atlas Vector Search over past reports/sightings, with privacy blurring and confidence shown.

**Saint as an add-on:** only if you got one of the 10 Saint slots. Saint can do the "act in the real world" step (email, calendar, browser) after the human approves, which also covers the human-control criteria of Agents That Ship and Gemini.

**Stacking pitfalls**
- Gemini needs "could only be built with Argon" (1M context, long decode, multi-agent, video). Make that explicit in the demo.
- The MongoDB video must **visibly show MongoDB in use** (e.g. the Atlas UI or a query panel).
- Write one submission note that covers models/agents (Gemini) + models/data sources (Real World) + tools, steps and approvals (Agents) + prompt, tools and accounts (Saint).
- Keep the cut to **3 minutes** so the same video works everywhere.

---

## 9. Submission checklist (all challenges)

- [ ] Deadline time confirmed: `__:__` Sun 25 Oct (**TBC**)
- [ ] Public **GitHub repo**, with only hackathon-written code shown in the demo
- [ ] README: what it does, who it's for (a named person), stack, **setup instructions**
- [ ] **3-minute demo video** with real inputs (photos, recordings or live data)
- [ ] Live demo rehearsed: < 3 min, plus 2 min Q&A, no slides
- [ ] Note: Gemini models/agents used and how
- [ ] Note: data sources (Real World)
- [ ] Note: tools, steps, where a human approves (Agents That Ship / Saint)
- [ ] MongoDB visibly in use in the video; Atlas features listed
- [ ] Privacy (blur faces and plates) and uncertainty shown
- [ ] No secrets in the repo (`.env` ignored)
- [ ] Submitted on the Encode platform, tracks/bounties selected, confirmation screenshotted

---

## 10. Project (fill in)

- **Name:** TBD
- **User (named person):** TBD
- **Challenges entered:** TBD
- **Models / agents used:** TBD
- **Setup:**
  ```bash
  # TBD: keep this updated so the demo runs from a fresh clone
  ```
