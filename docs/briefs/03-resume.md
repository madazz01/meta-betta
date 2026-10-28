# Brief 03 — Pick up where you left off (resume + new session)

Read `AGENTS.md` first. Briefs 01–02 must be done.

## Goal
Close VS Code tonight, open it tomorrow, and the chat carries on in the same Muse session with the earlier messages showing. A "New chat" button starts fresh.

## Build
1. Save the current `sessionId` in the extension's `workspaceState` (per workspace) whenever a session starts.
2. On the first message after VS Code opens: if a saved id exists, `client.resumeSession({ sessionId, onApproval, onApprovalError })` (pass the approval handlers here so approvals pending from before are handled). If resume fails (session gone, discarded, foreign), quietly start a new session and show one line: "Couldn't reopen yesterday's chat, so I've started a fresh one."
3. When the panel opens, show the previous conversation: read the resumed session's items (user and agent messages only; thinking collapsed) and render them. If the SDK can't list history without a turn, show the last 20 messages you stored yourself in `workspaceState` (text only, capped).
4. Header bar in the panel with a **New chat** button (confirm: "Start a new chat? The old one stays saved by Muse.") → clears the stored id and starts a new session.
5. Tests for the "which session do we use" decision (pure function: saved id? resume ok? → action).

## Done when
- Build + tests pass.
- F5 → chat a little → close the dev window → F5 again → the old messages show, and asking "what did I ask you first?" gets the right answer.
- New chat → a fresh session; the old one isn't used.

## Handover
Plain English + commit `03: resume yesterday's chat`.
