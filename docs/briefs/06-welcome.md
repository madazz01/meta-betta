# Brief 06 — The welcome (quick hello + how the memory works)

Read `AGENTS.md` first. Briefs 01–05 must be done.

## Goal
The first time someone opens Meta Betta in a workspace with an empty brain, a **welcome under a minute**: their name, what we're doing here, and one short message on how Meta Betta remembers things. Users installing a VS Code extension already know their way around: don't explain VS Code, chat or files, only what's new (the memory).

## Build
1. **Step 0 is the trust + brain card from brief 04** ("To remember you and this project, I need to trust this folder and add a small brain/ folder. OK?", or "Pick where to keep your project" when no folder is open). The welcome continues only after Yes; on "Not now" skip straight to normal chat.
   Then trigger the rest when the brain exists but `brain/me.md` is still the starter template. (Skip button always visible.)
2. Send Muse the welcome script (in `extension/src/brain/prompts.ts`). Muse runs it one step at a time, waiting for the user each step:
   - **Hello:** "G'day! What should I call you?" → writes their name to `brain/me.md`.
   - **What are we doing?** "What are we working on in this folder?" (a line or two is plenty) → writes the START HERE section of `brain/project.md`, then plays it back in one line.
   - **How I remember: ONE short message**, roughly:
     > "Quick one on how I remember: notes on you and this project live in `brain/` (the Brain panel; edit anything). I quick-save as we go, and 💾 **Save my day** writes up where we're up to. Close everything whenever; next time I start with 'Here's where we're up to'."
     A small "How does this work?" link under it expands a few more lines for anyone curious.
   - **Finish:** "What's first?" → normal chat from here.
3. While the memory message shows, the panel briefly outlines the Brain panel and the 💾 button.
4. Plain, friendly, brief. No over-explaining.

## Done when
- On a fresh folder the welcome runs end to end in under a minute, leaves the name in `brain/me.md` and a START HERE in `brain/project.md`, and outlines the Brain panel + 💾 during the memory message.
- Skip works at any point and the normal chat carries on.

## Handover
Plain English + commit `06: welcome`.
