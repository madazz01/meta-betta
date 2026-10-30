# 08d — New chat and Fork open new tabs (one tab works at a time)

Read `AGENTS.md` first. 08c must be done.

## Why
Bryan: clicking the Claude icon in VS Code opens a new chat in a tab next to the existing one,
and that's what New chat should do. Fork too, so the original stays open beside the fork.
We keep one rule Claude Code doesn't have: **only one tab works at a time per folder**, so
snapshots and ↩ Undo always know exactly which turn changed what.

## Build
0. **First, a small style tweak + your uncommitted button changes.** Make the four command
   buttons in the header (Goal · Side question · Fork · Usage) **little pills**: fully rounded
   ends, a slightly **lighter grey** than the Save my day · ↩ Undo · New chat buttons (e.g. the
   secondary button colour mixed lighter, or `--vscode-badge-background`), smaller padding and
   text. Save my day · Undo · New chat keep their grey button style.
   **One-word labels so the header stays narrow:** **Save · Undo · New** | **Goal · Side · Fork ·
   Usage**. Tooltips keep the full meaning ("Save my day", "Undo the last change", "New chat in a
   new tab", "Set a goal", "Side question", "Fork this chat into a new tab", "Usage so far").
   Update any tip/nudge text that names the old labels. Commit this together with the
   uncommitted chat.css/chat.html button tweaks as `08c: header pills` before starting the tabs.
1. **One controller per chat tab.** Today `extension.ts` makes one `ChatController` (with one
   `MuseHost` = one `muse serve`). Change to: the **main chat** (sidebar view + its panel, exactly as
   today) keeps the existing controller; each extra tab gets its **own** `ChatController` + `MuseHost`
   + `createWebviewPanel` (`ViewColumn.Active`, `retainContextWhenHidden`). Shared across all of
   them in the window: brain, snapshots/safety net, settings, the usage status bar, the output
   channel. Disposing a tab closes its MuseHost cleanly (no orphaned `muse serve`).
2. **New chat** → opens a new tab with a fresh session (same welcome/catch-up rules as a new chat
   today). The tab title is the session label ("Session 58f2 · …"), updated as it's named.
3. **Fork** → `session/fork` from the current session, then open the fork in a **new tab**. The
   original tab stays exactly where it was. Fork tab title: "Fork of <label>".
4. **One works at a time (per workspace folder).** A small shared `TurnLock` (in-memory, per
   workspace root). Before a tab sends a turn it takes the lock; it releases on turn end, stop,
   error or tab close (always, use finally). If another tab holds it:
   - the message waits in that tab with one muted line: "Muse is busy in another tab. I'll start
     this as soon as it's done." plus two small links: **Go to it** (reveals that tab) and
     **Stop it** (interrupts the other turn, then this one starts);
   - queued messages start automatically, oldest first. Side questions (/side) don't take the lock
     (they don't edit files).
5. **Undo stays per tab and exact.** Snapshots already wrap each turn; with the lock, turns never
   overlap. The header ↩ Undo in a tab undoes that tab's last change. If a later turn in another
   tab touched the same files, use the existing "changed since" check and ask first.
6. **Status bar usage** shows the total for the window (all tabs), as now.
7. **Reload:** only the main chat restores automatically (as today). Extra tabs aren't restored
   after a window reload. Their sessions are still in /resume. Don't build panel serializers.
8. Tests: TurnLock (take/release/queue order, release on throw, release on dispose); fork opens
   a second controller with the forked session id and leaves the first untouched; closing a tab
   disposes its host; side questions bypass the lock.

## Done when
- Build + all tests pass.
- Installed: click New chat → a second tab opens next to the first, fresh session, first tab
  untouched. Click Fork in tab 1 → a third tab "Fork of …" with the same history.
- Ask something long in tab 1, and while it works send something in tab 2 → tab 2 shows the busy
  line, then starts by itself when tab 1 finishes. "Stop it" works.
- Undo in each tab only undoes that tab's change.
- Close the extra tabs → no leftover `muse` processes (Task Manager).

## Handover
Plain English + commit `08d: tabs`. Commit only your own files.
