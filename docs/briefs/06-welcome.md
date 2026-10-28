# Brief 06 — The welcome (quick hello + how the memory works)

Read `AGENTS.md` first. Briefs 01–05 must be done.

## Goal
The first time someone opens Meta Betta in a workspace with an empty brain, a **2-minute welcome**: learn their name and what we're doing here, then a quick, simple tour of how Meta Betta remembers things, so they trust it from day one. No games, no tests. Short and friendly.

## Build
1. Trigger: brain exists but `brain/me.md` is still the starter template. (Skip button always visible.)
2. Send Muse the welcome script (in `extension/src/brain/prompts.ts`). Muse runs it one step at a time, waiting for the user each step:
   - **Hello:** "G'day! What should I call you?" → writes their name to `brain/me.md`.
   - **What are we doing?** "What are we working on in this folder?" (one or two lines is plenty) → writes the START HERE section of `brain/project.md`. Then one line back in plain words to show it understood.
   - **The quick tour** (Muse explains in plain words; the panel highlights each part as it's mentioned):
     1. **Your brain folder:** "I keep notes about you and this project in the brain/ folder. That's the cards in the Brain panel. You can open and edit any of them."
     2. **Saving:** "I quietly save progress as we go, every so often. At the end of the day, press 💾 Save my day and I'll write down where we're up to and what's next."
     3. **Picking up again:** "Close everything whenever you like. Next time, I'll read the brain and start with 'Here's where we're up to'. No re-explaining."
   - **Finish:** "That's it. What's the first thing you'd like to do?" → normal chat from here.
3. The panel highlights the matching thing during the tour (the Brain panel, the 💾 button, the header) with a gentle outline for a couple of seconds.
4. Everything in plain English, no jargon, whole welcome under 2 minutes.

## Done when
- On a fresh folder the welcome runs end to end, leaves the name in `brain/me.md` and a START HERE in `brain/project.md`, and highlights the three parts during the tour.
- Skip works at any point and the normal chat carries on.

## Handover
Plain English + commit `06: welcome and memory tour`.
