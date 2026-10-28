# Brief 06 — The first shift (onboarding by doing)

Read `AGENTS.md` first. Briefs 01–05 must be done.

## Goal
The first time someone opens Meta Betta in a workspace with an empty brain, Muse runs a friendly 10-minute "first shift": a few quick real jobs that show what it can do, while it gets to know them and fills in the brain. Nobody feels tested. Every job succeeds.

## Build
1. Trigger: brain exists but `brain/me.md` is still the starter template → show a card: "Want a quick 10-minute first shift? I'll show you what I can do and learn how you like to work." [Let's go] [Skip].
2. Let's go → send Muse the first-shift script (in `extension/src/brain/prompts.ts`). Muse runs it one step at a time, waiting for the user each step:
   - **Job 1 — Look around:** "Tell me what's in this folder in plain words" (Muse reads the workspace). Then ask: "What do you do, and what are you building here?" → write `brain/me.md` basics + `brain/project.md`.
   - **Job 2 — A tiny real task:** Muse offers 3 small useful jobs based on the folder (e.g. "write a README", "find TODOs", "add a test"), the user picks one, Muse does it using the loop (simplest version → yes → do → check).
   - **Job 3 — The wall:** Muse tries something that commonly fails (e.g. running a script that isn't there / a command that needs a missing tool), shows it trying 2 other ways, says which worked, and adds it to `brain/tricks.md`. (Pick something safe and inside the workspace.)
   - **Job 4 — How do you like it?** Ask 2 quick questions: short answers or full explanations? Want me to check with you before every change, or only big ones? → `brain/me.md`.
   - **Finish:** run Save my day, then show: "That's your brain. Next time I'll start right here." and point at the Brain panel.
3. The panel shows a small progress strip "First shift: 1 · 2 · 3 · 4 · ✓" while it runs. Skip/stop any time.
4. Keep all wording friendly and plain. No jargon.

## Done when
- On a fresh folder the whole first shift runs end to end and leaves a filled-in brain (me.md, project.md, tricks.md with at least one trick, good-for.md, today's log).

## Handover
Plain English + commit `06: first shift onboarding`.
