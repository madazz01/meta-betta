# Brief 05 — "Save my day"

Read `AGENTS.md` first. Briefs 01–04 must be done.

## Goal
One button that makes Muse write down what happened, so tomorrow starts where today ended.

## Build
1. A **💾 Save my day** button in the chat header (and a command "Meta Betta: Save my day").
2. Clicking it sends Muse this turn (keep the wording in `extension/src/brain/prompts.ts` so it's easy to tune):
   ```
   Save my day. Update the brain so a fresh session tomorrow can carry on without me re-explaining:
   - brain/project.md: rewrite the START HERE section (where we're up to, what works, what's next, any open problems). Keep the rest.
   - brain/log/<today>.md: append what we did today in plain bullet points.
   - brain/tricks.md: add any workaround that worked today (one line each, newest first).
   - brain/good-for.md: add anything new you did for me (plain English, e.g. "Read a photo of a receipt").
   - brain/me.md: add anything new you learned about how I like to work.
   Only edit files inside brain/. Then reply with 3 short lines: what you saved, what's next tomorrow, and "Saved ✓".
   ```
3. Auto-allow file edits **only inside `brain/`** during this turn (approve via `onApproval` when the request is for a path under `brain/`; anything else → show the normal approval card).
4. When the turn completes, flash the Brain panel cards that changed and show "Saved ✓ — see you tomorrow" in the chat.
5. **Periodic quick save:** while the user is active, do a quiet quick save every 45 minutes or every 15 turns, whichever comes first (setting `metaBetta.autoSaveMinutes`, 0 = off). A quick save sends a shorter turn: update the START HERE section of brain/project.md and append to today's log, only inside brain/, reply with just "Saved ✓". Show it as a small "Saved ✓ 2:15pm" note in the status line, not a chat bubble. Never quick-save in the middle of a running turn; wait until it finishes.
6. Optional (only if trivial): if the workspace is a git repo, offer "Also commit the brain?" → `git add brain && git commit -m "Save my day <date>"`. Never push.

## Done when
- Build + tests pass (test the "is this path inside brain/" check, including tricky paths like `brain/../x`).
- With `metaBetta.autoSaveMinutes` set to 1 for testing, a quick save happens after a minute of chatting and shows "Saved ✓ <time>" in the status line.
- After a short session, Save my day updates project.md's START HERE + today's log, and a new session opens with the right "Here's where we're up to".

## Handover
Plain English + commit `05: save my day`.
