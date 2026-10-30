# 08b fixes — approvals that don't get in the way

Read `AGENTS.md` first. 08b must be done.

## Why
Live test (installed .vsix, mb-test): "use the shell to delete todo.txt" took **10 clicks**.
Muse sends one approval per command stage, and for harmless stages too (Get-Date,
Get-ChildItem, Select-Object), plus the rule 9 backup (New-Item .backups\..., Copy-Item).
Answered cards also stay in the chat with their buttons showing. Target: that test is **one
choice**.

## Build
1. **Approval picker over the message box** (replaces the in-chat cards). When Muse asks, a
   compact panel slides up over the input area (input disabled underneath):
   - Title: plain English for what it wants, e.g. "Delete todo.txt?" (from the risky stage),
     with the full command small and collapsible underneath.
   - Numbered choices, keyboard friendly (↑/↓ + Enter, or press 1/2/3; Esc = Reject):
     `1  Allow once`
     `2  Always allow in this project: Remove-Item ...` (Muse's allow_local_prefix label)
     `3  No, tell Muse what to do instead…` (opens a one-line box in the same panel; the
        text goes with the abort as feedback. Empty = plain reject)
   - Build the list from Muse's `availableChoices` in its order. Don't invent choices it didn't
     send (Muse has no "all projects" choice, so we don't offer one).
   - Several requests waiting at once → one at a time, "1 of 2" in the corner.
2. **One ask per command, not per stage.** Group requests that share an `approvalId`
   (`requirementId.approvalId`) into one picker. Choice 1 answers every stage of that command.
   Choice 2 applies each stage's own allow_local_prefix. Reject aborts the command.
   The picker lists the stages as short lines so you can see what's in it.
3. **Read-only stages don't ask.** The extension auto-answers `allow_once` for a stage when its
   argv[0] (case-insensitive) is on a small read-only list **and** the stage has no output
   redirection (`>`, `>>`, `Out-File`, `Set-Content`, `Add-Content`, `Tee-Object`):
   `Get-Date, Get-ChildItem, ls, dir, Get-Content, cat, type, Test-Path, Get-Item, Get-Location,
   pwd, Select-Object, Where-Object, Sort-Object, Measure-Object, Format-Table, Format-List,
   Select-String, Write-Output, echo, git status, git log, git diff, node --version, npm --version`.
   (For git/node/npm match the first two argv tokens.) Keep the list in one pure helper with tests.
   Show a single quiet row in the chat: "✓ Looked at: Get-ChildItem, Select-Object".
   If every stage of a command is read-only, no picker at all.
4. **Rule 9 backups don't ask.** Auto-allow `New-Item -ItemType Directory` and `Copy-Item` only
   when every path argument resolves inside `<workspace>\.backups\` (destination for Copy-Item;
   the source must be inside the workspace). Quiet row: "✓ Backed up todo.txt".
   Anything else (Remove-Item, Move-Item, installs, network, writes outside .backups) still asks.
5. **Answered = one line.** After a choice, the request leaves one row in the chat history:
   "✓ Allowed once: delete todo.txt" / "✓ Always allowed here: Remove-Item" /
   "✗ Rejected: delete todo.txt, told Muse: use the bin instead". No leftover buttons.
6. **Small ones from the same test:**
   - A fresh chat that **starts with a job** shouldn't open with "Here's where we're up to". That
     opener is only for greetings/catch-ups. Jobs get straight to it.
   - Catch-up should notice an **unanswered last message** (the window closed or crashed before
     Muse replied): "Last time you asked me to add pancakes to readme.txt and it didn't get done.
     Want me to do it now?"
7. Tests: grouping by approvalId; the read-only helper (incl. redirection = not read-only);
   the .backups path check (inside, outside, `..` tricks, other drives); the picker choice
   mapping to choiceIds per stage; the answered-row text.

## Done when
- Build + all tests pass.
- Installed or F5, fresh folder: "use the shell to delete todo.txt" → **one** picker:
  "Delete todo.txt?" → press 1 → it's backed up to .backups and deleted, chat shows
  "✓ Backed up todo.txt" and "✓ Allowed once: delete todo.txt". ↩ Undo brings it back.
- "run node --version" → no picker.
- Press 3, type "don't delete, rename it to old-todo.txt" → Muse doesn't delete and goes with the rename
  (which asks again, because Move/Rename-Item isn't read-only).
- Esc rejects. Arrow keys + Enter and 1/2/3 all work.

## Handover
Plain English + commit `08b: fixes`. Commit only your own files.
