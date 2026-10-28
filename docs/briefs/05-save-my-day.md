# Brief 05 — "Save my day"

Read `AGENTS.md` first. Briefs 01–04 must be done.

## Goal
One button that makes Muse write down what happened, so tomorrow (or another window) starts where this one ended. **The brain only grows: saves add new entries, they never overwrite.** Every chat saves under its own session label (brief 04), so two windows working at once never wipe each other out.

## Build
1. A **💾 Save my day** button in the chat header (and a command "Meta Betta: Save my day").
2. Clicking it sends Muse this turn (keep the wording in `extension/src/brain/prompts.ts` so it's easy to tune):
   ```
   Save my day. Don't edit any files. Reply with ONLY these sections (skip any that are empty), plain English, short bullet points:
   ## project
   Where we're up to, what works, what's next, any open problems.
   ## log
   What we did in this session.
   ## tricks
   Any workaround that worked (one line each).
   ## good-for
   Anything new you did for me (e.g. "Read a photo of a receipt").
   ## me
   Anything new you learned about how I like to work.
   ```
3. When the turn completes, the **extension** (not Muse) splits the reply by heading and calls `appendEntry` (brief 04) for each section: `project` → `brain/project.md` (under Updates), `log` → `brain/log/<today>.md`, `tricks` → `brain/tricks.md`, `good-for` → `brain/good-for.md`, `me` → `brain/me.md`. Each entry is headed with the date, time and this chat's session label. Muse never writes brain files, so there's nothing to approve. Show the reply in the chat as a short "Saved ✓, here's what I noted" card with the sections folded.
4. Flash the Brain panel cards that changed and show "Saved ✓ — see you tomorrow".
5. **Periodic quick save:** while the user is active, do a quiet quick save every 45 minutes or every 15 turns, whichever comes first (setting `metaBetta.autoSaveMinutes`, 0 = off). A quick save asks only for the `project` and `log` sections and appends them the same way. Show it as a small "Saved ✓ 2:15pm" note in the status line, not a chat bubble. Never quick-save in the middle of a running turn; wait until it finishes.
6. Optional (only if trivial): if the workspace is a git repo, offer "Also commit the brain?" → `git add brain && git commit -m "Save my day <date>"`. Never push.
7. **Backup copy:** setting `metaBetta.backupFolder` (empty = off). After every Save my day and quick save, the extension copies `brain/` to `<backupFolder>/<workspace folder name>/brain/`, replacing the old copy. Point it at a Google Drive / OneDrive / Dropbox folder and the user's sync app puts it in the cloud for free. Show "Backed up ✓" next to "Saved ✓". If the folder is missing or not writable, say so in one plain line and carry on; never block the save.

## Done when
- Build + tests pass (test splitting a save reply into sections, including a missing section, an extra unknown heading and an empty reply).
- With `metaBetta.autoSaveMinutes` set to 1 for testing, a quick save happens after a minute of chatting and shows "Saved ✓ <time>" in the status line.
- After a short session, Save my day adds new entries to project.md and today's log (earlier text untouched), and a new session opens with the right "Here's where we're up to".
- Two windows on the same folder both press Save within a few seconds: both entries are in the files, each with its own session label.
- With `metaBetta.backupFolder` set to a test folder, a save leaves an up-to-date copy of brain/ there (test the copy with a temp folder).

## Handover
Plain English + commit `05: save my day`.
