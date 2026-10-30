# 08g — Flow: tidy steps, centred input, an Approvals toggle

Read `AGENTS.md` first. **Before starting: commit the leftover popup-anchoring change in
`extension/media/chat.js` as `08f: popup anchoring`, so you start on a clean tree** (the 09 run
spent ages splitting hunks around it). Do this as normal Muse, or from Meta Betta.

## Why
Bryan's first real run (Meta Betta building brief 09 on itself, recorded for the video):
it works, but every read/fetch/command fills the screen, the input box stretches the full width,
and clicking Allow all day kills the flow.

## Build
1. **Group a turn's steps into one line.** Consecutive step rows in a turn (reads, searches,
   fetches, commands, edits, "Allowed once" rows, thinking) collapse into **one muted summary
   line**, updated live while it works: "▸ Read 8 files · ran 3 commands · edited 2 files".
   Click → expands to the full list (as today). Shown on their own, never folded: the approval
   picker while it's waiting, errors ("didn't work: …"), and Muse's text messages (each text
   message starts a new group after it). Every row names its target: no bare "Wrote ✓", use
   "Wrote <file>" (or "Wrote a file" if the name is unknown).
2. **Centre the input box.** The whole input box (text + strip) is centred, `width: 33vw` with
   `min-width: 560px` and `max-width: 100% - 32px` (so narrow panels still use the full width).
   The chat column above keeps its current width; the status line sits under the box, aligned
   with it.
3. **Approvals toggle** in the strip, left of Effort: **"Approvals: Auto ▾"** with three choices:
   - **Ask**: current behaviour (picker for anything not read-only / not a backup).
   - **Auto** (default): the extension auto-answers `allow_once` for every stage that stays
     **inside the workspace**: builds, tests, node/npm/npx scripts, `git` except `push`,
     file edits/creates/deletes/moves whose path arguments all resolve inside the workspace
     (reuse `insideDir` and the token rules: no `$ % ~`, backtick or wildcards outside quotes
     → ask). Still **asks** for: anything with a path outside the workspace, installs and
     downloads (`npm install/i/add`, `pip`, `winget`, `choco`, `irm`, `iwr`, `curl`, `Invoke-WebRequest`),
     `git push`, network/process approvals, and anything it can't parse. Auto-answered stages
     show in the step group as "✓ auto-allowed: …".
   - **All**: selects Muse's `allowAll` approval mode for **this tab only** (`session/setApprovalMode`),
     after a one-time confirm: "Muse will run anything without asking in this chat. Undo covers
     files in this folder only." The button turns red ("Approvals: All") while it's on. New tabs
     and reloads go back to Auto. Switching back to Ask/Auto re-selects `promptUnmatched` and checks it was confirmed.
   Keep the Auto rules in one pure helper next to `isReadOnlyStage`, with tests.
4. **Undo after git commits.** If a turn's snapshot shows it ran `git commit` (or the repo HEAD
   moved during the turn), the Undo confirm says: "This reply also made git commits. Undo puts
   the files back, but the commits stay in git history." Keep the button. Just warn.
5. **Welcome when the first message is a job.** If the very first message in a fresh folder is a
   job (not a greeting), skip the name questions for now, do the job, and put the short memory note
   **before** the reply, not tacked on after the handover. Ask the name next time the user greets.
6. **Fork replay.** Fork tabs replay the full source transcript (both sides, including step
   rows). Today only the user's messages come across. Test it.
7. **Tip wording.** The front-door tips (brain.ts) still say "📊 Usage chip", "💬 chip" etc. Change
   them to the pill names ("the Usage pill", "the Side pill", "the Goal pill", "the Fork pill") and
   mention that pills can be swapped by right-clicking.
8. Tests: grouping (which rows fold, which break a group, live counts); Auto rules (inside/outside
   paths, installs, git push, tokens); All mode select + revert; commit-warning detection; tips text.

## Done when
- Build + all tests pass.
- A build/test turn shows one line like "▸ Read 8 files · ran 3 commands · edited 2 files" and
  Muse's messages, nothing else. Click to expand.
- The input box sits centred at about a third of a wide window, and full width in a narrow one.
- With Approvals: Auto, a full build-and-test turn runs with **no** pickers. `npm install x` or
  editing a file outside the folder still asks. All turns red and stops all asking in that tab only.
- Undo on a turn that committed shows the git warning.

## Handover
Plain English + commit `08g: flow`. Commit only your own files.
