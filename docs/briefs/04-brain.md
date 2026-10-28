# Brief 04 — The brain folder + brain panel

Read `AGENTS.md` first (the "brain folder" and "loop" sections). Briefs 01–03 must be done.

## Goal
Every workspace gets a `brain/` folder that Muse reads at the start of each session, and the user can see it as friendly cards next to the chat.

## Build
1. `extension/src/brain/brain.ts` (pure, testable with a fake file system):
   - `ensureBrain(root)`: if missing, create `brain/me.md`, `brain/project.md`, `brain/tricks.md`, `brain/good-for.md`, `brain/log/` with short starter templates (headings + one hint line each, plain English). Never overwrite existing files.
   - `ensureFrontDoor(root)`: if the workspace has no `AGENTS.md`, create one from the template below. If it has one, add our section between `<!-- meta-betta:start -->` and `<!-- meta-betta:end -->` markers (replace only that section on later runs; never touch the rest).
2. Front-door section template (keep it short; Muse reads it every session):
   ```
   <!-- meta-betta:start -->
   ## Meta Betta brain (read first, every session)
   1. Read brain/me.md, brain/project.md (START HERE section), brain/tricks.md and today's brain/log file if it exists.
   2. Open your first reply with "Here's where we're up to:" and 2–3 plain lines from brain/project.md, then ask what we're doing today.
   3. Talk to the user the way brain/me.md says. Plain English, no jargon.
   4. Before building, propose the simplest version in one or two lines and wait for a yes.
   5. When something fails, try 2–3 other ways before giving up, and say plainly which one worked. Add any workaround that worked to brain/tricks.md.
   6. Finish every job with: what you did (plain words), how to use it (click by click), anything you couldn't check.
   7. Never edit files outside this workspace.
   <!-- meta-betta:end -->
   ```
3. Run `ensureBrain` + `ensureFrontDoor` when the chat starts in a workspace (ask once first: "Can I add a small brain/ folder so I remember this project between sessions?" Yes / Not now; remember the answer in workspaceState).
4. **Brain panel:** a second webview view `metaBetta.brain` ("Brain") under the chat in the same container. It shows each file as a card: title, last updated, the first ~6 lines (for project.md: the START HERE section). Click a card → open the file in the editor. Refresh when files change (FileSystemWatcher on `brain/**`).
5. Tests for `ensureBrain` / `ensureFrontDoor` (create, don't overwrite, marker replacement).

## Done when
- Build + tests pass.
- F5 on a fresh folder → first message → asked about the brain folder → Yes → `brain/` + `AGENTS.md` appear → the Brain view shows five cards.
- Next session, Muse's first reply starts with "Here's where we're up to:".

## Handover
Plain English + commit `04: brain folder and brain panel`.
