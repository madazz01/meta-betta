# 08c — Calm layout: one column, bare minimum

Read `AGENTS.md` first. Do this after `08b-fixes`.

## Why
Bryan, after using the installed build: "the chat is too chat-bot looking, and the questions and
answers on opposite sides is annoying. You want a simple constant flow, only the bare minimum in
the actual workspace." The model to follow is a coding-agent transcript (the way the Claude Code
panel in VS Code reads), not a phone messenger. Borrow the idea only, write our own code.

## Build (webview: chat.css / chat.js, no behaviour changes)
1. **One column, left-aligned, full width.** No bubbles, no left/right split.
   - **Your message:** a full-width box with a slightly lighter background and a thin border,
     regular text. No blue fill.
   - **Muse's reply:** plain text straight on the background. No box, no border.
2. **A quiet timeline.** A small dot in the left gutter for each step of a turn (thinking, tool
   rows, the reply), with a thin, faint vertical line joining the steps of one turn. Dots: muted
   grey, the reply dot slightly brighter. That's all the decoration there is.
3. **Steps are one muted line each**, collapsed by default:
   - "Thought for 5s" (click to expand)
   - "Ran node --version ✓", "✓ Looked at: Get-ChildItem", "✓ Backed up todo.txt",
     "✓ Allowed once: delete todo.txt"
   - Edits: "Edited notes.txt (+1)" (click → the diff/the file)
4. **Times:** small and muted, right-aligned on the line above each of your messages, and on the
   first reply line after a long gap. Keep the day dividers ("── Fri 30 Oct ──"), muted.
5. **Trim the chrome:**
   - Header: session name on the left, then **icons only** on the right (New chat, Save my day,
     Undo) with tooltips. No filled buttons.
   - "Try another way": hover only, a small muted link at the end of the reply (already hover;
     make it smaller/quieter).
   - Quick-action chips (Goal · Side question · Fork · Usage): move into a small **"+"** button
     at the left of the input that opens them as a menu (same as typing "/"). Nothing above the
     input by default.
   - The Normal/Deep toggle and Send: compact, inside the input box on the right.
   - Status ("Ready", "Saved ✓ 8:07am"): one muted line under the input, as now.
   - One-time notices (sandbox line, memory on): one muted line, no box.
6. **Readability:** max line length about 90 characters for reply text (wide windows get margins,
   not super long lines). Code blocks keep their own background. Use VS Code theme variables
   everywhere so light and dark themes both look right.
7. No logic changes. Existing tests stay green. Add a small DOM test if there is one for message
   rendering (user vs reply classes).

## Done when
- F5 or installed: a conversation reads top to bottom in one column. Your messages in light
  boxes, Muse's as plain text, steps as one-liners with dots, nothing bright except what you
  need to read.
- Header shows three icons with tooltips. No chips row above the input; "+" opens them.
- Looks right in a light theme and a dark theme.

## Handover
Plain English + commit `08c: calm layout`. Screenshot-worthy, since this is what the video shows.
