# Brief 02 — Wire the chat to Muse Code

Read `AGENTS.md` first (especially "Muse Code SDK — facts already proven"). Brief 01 must be done.

## Goal
Replace the echo with real Muse Code: the user's message goes to a Muse session in the open workspace, and the reply streams into the panel as it's written. Thinking is tucked away, tool activity shows as short plain rows, and tool approvals appear as buttons.

## Build
1. Add dependency `@muse-code/sdk` pinned to exactly `1.4.14` in `extension/package.json`. (It is ESM. From the CommonJS extension, load it with a dynamic `import()`; check this works in the built output.)
2. `extension/src/muse/resolveBin.ts`: find the Muse binary (setting `metaBetta.museBin` → newest `%LOCALAPPDATA%\Programs\muse\muse-bin-*.exe` → `muse`). Pure function + tests (inject the directory listing).
3. `extension/src/muse/museHost.ts`: one class that owns the SDK client:
   - `start(workspaceRoot)`: `MuseClient.spawn({ museBin, args:["serve"], clientInfo:{ name:"meta_betta", version } })` then `startSession({ workspaceRoot })`. Start lazily on the first message.
   - `send(text)`: `sendUserTurn`, iterate `turn.items()` and emit simple events to the view:
     - `agentMessage` → stream its text into one assistant bubble (update as it grows; use `item/delta`s or re-read the item text — check the types to see which is available);
     - `reasoning` → a collapsed "Thinking…" line under the bubble (click to expand);
     - tool calls / commands / file edits → one short row each, e.g. "📄 Edited src/app.js", "▶ Ran npm test" (look up the item types in the SDK `.d.ts` files; unknown kinds → a generic "Working…" row);
     - `reminderChild` and anything internal → hidden.
     - on `turn.completed`: `completed` → nothing extra; `failed` → a friendly line ("Something went wrong: <short reason>. Want me to try again?"), never a stack trace; `cancelled` → "Stopped."
   - `onApproval`: send `{ type:"approval", id, title, choices:[{id,label}] }` to the webview; wait for the user's click; return that `choiceId`. Default to the safest choice if the panel is closed.
   - `stop()`: cancel the current turn. `dispose()`: `client.close()`.
4. Webview: a **Stop** button while a turn is running; approval cards with one button per choice (plain labels: "Allow once", "Don't allow"…); the Thinking line; tool rows.
5. **Windows sandbox not set up:** Muse Code's Windows sandbox (`backend=windows_elevated`) needs a one-time admin setup (it creates local sandbox accounts + firewall rules). If starting/using the host fails for that reason (check `muse sandbox windows check` output for `status=ready`), show: "Muse needs a one-time setup with admin rights. Open PowerShell as administrator and run `muse sandbox windows setup`, then come back." (Copy button.) Don't ask users to run VS Code as admin.
6. If Muse isn't installed or isn't logged in: show a friendly card: "I can't find Muse Code. Install it with: `irm https://dev.meta.ai/install.ps1 | iex`, then run `muse` once to log in." (Copy button.)
6. Status line under the input: "Muse is thinking…", "Muse is working…", "Ready".

## Done when
- Build + tests pass.
- F5 → open a test folder → ask "In one sentence, what's in this folder?" → an answer streams in; thinking is collapsed; no stack traces anywhere.
- Ask it to create a small file → an approval card appears → "Allow once" → a tool row shows the edit.

## Handover
Plain English: how to try the two checks above, what you couldn't test, suggestions. Commit `02: chat talks to Muse Code`.
