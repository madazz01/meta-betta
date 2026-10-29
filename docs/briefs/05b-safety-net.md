# Brief 05b — Safety net: back up before changing, and "Undo that"

Read `AGENTS.md` first. Briefs 01–05 must be done.

## Goal
Nobody loses work to a bad edit. Two layers:
1. **Muse backs up first** (a front-door rule, same habit our own team uses).
2. **The extension takes its own snapshot before every turn**, so each reply that changed files gets an **↩ Undo that** button, whether Muse remembered to back up or not.

## Build
1. **Front-door rule 9** (brain.ts template; existing workspaces pick it up through the marker replacement):
   `9. Before changing an existing file, copy it to .backups/<date>/<same path> first, and say where the copy is in one line.`
   On first use, add `.backups/` to the workspace `.gitignore` (append only, never replace; create the file if missing).
2. **Snapshots (extension, not Muse):** `extension/src/safety/snapshots.ts`, using a **private shadow git repo** stored in the extension's workspace storage (`context.storageUri`): `git --git-dir=<storage>/shadow.git --work-tree=<workspace>`. It never touches the user's own `.git`, branches or index, and it works in folders that aren't git repos at all.
   - Before each turn is sent: snapshot the workspace (add all + write a tree/commit in the shadow repo). After the turn finishes: snapshot again.
   - Skip what the user's `.gitignore` skips, plus `node_modules/`, `.git/`, `.backups/`, `brain/` (the brain only grows and must never be "undone") and any file over 5 MB.
   - If git isn't installed: no snapshots, no Undo buttons, and one plain line once: "Install Git to get Undo on every change. Muse still backs up files before changing them." Everything else works.
3. **↩ Undo that:** if the before/after snapshots differ, show a small button under that reply: `↩ Undo that (3 files)`. Click → a short confirm listing the files → restore each changed file to its "before" content and delete files the turn created → reply in the chat: "Put back 3 files as they were at 10:40." If any of those files changed again since that reply, list them and ask before touching them. Undo works on any earlier reply, not just the last one.
4. Keep the shadow history small: keep the last 200 snapshots per workspace, prune older ones.
5. Tests (use a temp folder and real git): snapshot → edit + create + delete files → undo restores exactly the before state; ignored paths, brain/ and big files are left alone; "changed since" is detected; no-git path degrades quietly.

## Done when
- Build + tests pass.
- F5: ask Muse to change notes.txt and create a new file → the reply shows `↩ Undo that (2 files)` → click → both are back as they were, the new file is gone, brain/ untouched.
- Muse's reply mentions the `.backups/` copy when it changed an existing file.
- The user's own git history and staged files are unchanged after all of this (`git status` / `git log` same as before).

## Handover
Plain English + commit `05b: safety net`.
