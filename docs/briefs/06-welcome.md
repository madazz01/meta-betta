# Brief 06 — The welcome (quick hello + how the memory works)

Read `AGENTS.md` first. Briefs 01–05 must be done.

## Goal
The first time someone opens Meta Betta in a workspace with an empty brain, a **welcome under a minute**: their name, what we're doing here, and one short message on how Meta Betta remembers things. Users installing a VS Code extension already know their way around: don't explain VS Code, chat or files, only what's new (the memory).

## Build
1. Trigger: memory is on (trusted folder, brief 04) and `brain/me.md` is still the starter template. No trust card here: opening a trusted folder in VS Code is the setup, same as other chat extensions. (Skip button always visible.)
2. Send Muse the welcome script (in `extension/src/brain/prompts.ts`). Muse runs it one step at a time, waiting for the user each step:
   - **Hello:** "G'day! What should I call you?" → the extension (not Muse, the brain only grows) appends a `Name: <name>` line to `brain/me.md`. Make `greetingName()` read a `Name:` line first (today it misses "Name: Bryan"; add a test), and keep the existing "I'm…/my name is…/call me…" fallbacks.
   - **What are we doing?** "What are we working on in this folder?" (a line or two is plenty) → writes the START HERE section of `brain/project.md`, then plays it back in one line.
   - **How I remember: ONE short message**, roughly:
     > "Quick one on how I remember: notes on you and this project live in `brain/` (the Brain panel; edit anything). I quick-save as we go, and 💾 **Save my day** writes up where we're up to. Close everything whenever; next time I start with 'Here's where we're up to'."
     A small "How does this work?" link under it expands a few more lines for anyone curious. Those lines must include, plainly: "Your brain is stored in this project, on your machine, and it's yours: easy to find, share, move or back up (set a backup folder in Settings). I read it each session so I can help, and on a contributor model Meta may use what I read, so keep passwords and keys out of it."
   - **Finish:** "What's first?" → normal chat from here.
3. While the memory message shows, the panel briefly outlines the Brain panel and the 💾 button.
4. Plain, friendly, brief. No over-explaining.

## Done when
- On a fresh folder the welcome runs end to end in under a minute, leaves the name in `brain/me.md` and a START HERE in `brain/project.md`, and outlines the Brain panel + 💾 during the memory message.
- Skip works at any point and the normal chat carries on.

## Handover
Plain English + commit `06: welcome`.
