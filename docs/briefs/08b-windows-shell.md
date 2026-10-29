# Brief 08b — Windows shell workaround: sandbox off, ask before every command

Read `AGENTS.md` first. Briefs 01–08 must be done.

## Why
On Windows, `muse serve` (the mode we drive) fails **every** shell command with
`sandbox enforcement unavailable: windows_elevated setup_required`, even when
`muse sandbox windows check` says `status=ready`. The terminal and `muse exec` are fine.
It's a Muse bug (reported on the Discord Meta thread). Until Meta fixes it, Muse
can read and edit files in our panel but can't run anything: no builds, no tests.

Proven on Bryan's machine (see `spike/shellcheck.mjs` and `spike/approvalmode.mjs`):
- `--sandbox-network enabled|restricted` and `--join` → same error.
- `serve --disable-sandbox` → shell works.
- **But** in the default approval mode Muse ran the command **without asking**.
  After `session/setApprovalMode { mode: "promptUnmatched" }` it asks before every
  command, one request per stage (`a; b; c` = 3 requests), with these choices:
  `Allow once` (allow_once) · `Always allow in this workspace: New-Item ...`
  (allow_local_prefix, decision approvedPolicyAmendment, scope localPersistent) ·
  `Reject` (abort, acceptsFeedback).

So the safety comes from approvals (the same way Claude Code works on Windows),
plus our own snapshots and ↩ Undo.

## Build
1. **Spawn args (museHost.ts):** on Windows (`process.platform === "win32"`) add
   `--disable-sandbox` to the `serve` args. Other platforms are unchanged. Put the
   choice in one small pure helper (`serveArgs(platform, trustWorkspace)`) so it's testable
   and easy to remove later. Add a setting `metaBetta.windowsSandboxWorkaround`
   (boolean, default `true`, description: "Muse's Windows sandbox has a bug in
   serve mode. When on, the sandbox is off and Muse asks before every command.")
   so we can turn it off the day Meta fixes it.
2. **Force asking:** whenever the sandbox is off, right after every `startSession` /
   `resumeSession` / fork, send `session/setApprovalMode` with `mode: "promptUnmatched"`
   via `this.connection.command(...)` (it mints its own commandId). If that call fails,
   **don't send the turn**: show "I couldn't make Muse ask before running commands, so
   I've stopped to be safe." and stay Ready. Never run sandbox-off without the
   prompt mode confirmed (`effectiveMode.mode === "promptUnmatched"`).
3. **Approval card:** the card already shows "Muse wants to run a command". Add:
   - the stage when `totalStages > 1`: "(step 2 of 3)" and that stage's `argv` joined
     as the detail line (the full command stays visible underneath, small);
   - the buttons straight from `availableChoices` using Muse's own labels, in its order.
     The "Always allow in this workspace…" button gets a one-line hint on hover:
     "Muse won't ask again for commands starting with this, in this project only."
   - Reject's `acceptsFeedback`: a small optional "tell Muse why" box, the same way
     Try another way works. Sent with the abort if filled in, otherwise just reject.
4. **One plain line, once per workspace** (first time a command card appears):
   "Muse's Windows sandbox has a bug right now, so I'll ask you before running any
   command. ↩ Undo still works on every change." Then never again (workspace state).
5. **Remove the old sandbox-bug notes:** `sandboxBugNoted` and its line become dead
   code when the workaround is on. Keep them only for the setting-off path.
   `sandboxNeedsSetup()` and the "run `muse sandbox windows setup` as admin" notice
   only apply when the workaround is off. **Brief 09 note:** with the workaround on,
   first run on Windows needs **no admin step**. Drop the sandbox-setup step from 09's flow
   (keep it behind the setting-off path).
6. **Harden chainNotifications (from the 08 review):** wrap each handler call in
   try/catch so one throwing handler can't stop the SDK's router (or ours) from
   getting the notification. Log the error to the output channel.
7. Tests: `serveArgs` per platform + setting; the turn is blocked when setApprovalMode
   fails or returns another mode; card labels/stage text from a recorded request (use the
   JSON shape above); chainNotifications keeps delivering after a handler throws.

## Done when
- Build + all tests pass.
- F5 on Windows: "run `node --version` and tell me the result" → approval card
  "Muse wants to run a command" with Allow once / Always allow… / Reject → Allow once →
  Muse answers with the real version.
- Ask the same again → card again. Pick "Always allow in this workspace: node ..." →
  third time, no card, it just runs.
- Reject with a reason → Muse doesn't run it and replies to the reason.
- The one-time line shows once, then never again for that folder.
- Setting off → back to today's behaviour (shell error + sandbox note).

## Handover
Plain English + commit `08b: windows shell workaround`. Commit only your own files.
