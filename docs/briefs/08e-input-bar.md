# 08e — Input bar: fixed buttons, your own shortcut pills, Effort button

Read `AGENTS.md` first. Do this after `08d: fixes 2`.

## Why
Bryan's design, modelled on a coding-agent input box: one box split in two. Type in the top half,
everything you click lives in the bottom strip. Save / Undo / New are fixed. The four shortcut
pills are **yours**: right-click one to swap it for any other shortcut.

```
┌──────────────────────────────────────────────────────────────────┐
│ Type a message...                                                │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [Save] [Undo] [New] │ (Goal) (Side) (Fork) (Usage)   [Effort: Normal ▾] [Send] │
└──────────────────────────────────────────────────────────────────┘
```

## Build
1. **One input box, split.** Top: the textarea (grows with text as now). A thin divider. Bottom
   strip: the buttons below, left to right. The old "+" button goes (the pills and "/" cover it).
   The header keeps only the session name.
2. **Fixed buttons: Save · Undo · New.** Clearly "part of the furniture": small squared buttons with
   an outline (no fill), regular text colour, the same as each other. Not movable, not right-clickable.
   Same tooltips as now. A thin vertical divider after New.
3. **Four shortcut pills (user slots).** Small fully-rounded pills, **grey background with white
   text** (in light themes use a darker grey so white text stays readable). Defaults: **Goal ·
   Side · Fork · Usage**.
   - **Right-click a pill** (also: long-press, or the context-menu key when focused) → a small
     popup list of every shortcut we have, built from one master list (the same source as the "/"
     menu): Goal, Side, Fork, Usage, Recap, Compact, Model, Effort, Tasks, Skills, Plugins, Export,
     Resume, Save my day… Each row shows its name and one-line description. The pill's current
     choice is ticked. Click one → that pill becomes it. Bottom row: **Reset all to defaults**.
   - Choices are saved per user (globalState), so they follow you to every project. No duplicates:
     picking one that's already on another pill swaps the two.
   - Left-click runs it exactly like the old button did.
4. **Green hover.** Every button in the strip (fixed buttons, pills, Effort, Send) lights up
   **green** on hover/focus: background `#1f9d55`-ish with white text for pills, a green outline
   plus green text for the fixed buttons. Put the green in one CSS variable (`--mb-accent`) so it's
   easy to change. Keyboard focus shows the same green.
   **The whole input box** gets a thin rounded border that glows `--mb-accent` green while the
   textarea is focused (a 1px border plus a soft outer glow), and goes back to a plain subtle border
   when it isn't. That's Meta Betta's signature colour.
5. **Effort button.** Replace the bare "⚡ Normal" toggle with a labelled button **"Effort: Normal ▾"**.
   Click → a small menu of the effort levels Muse supports for the current model (from the existing
   /effort handling, e.g. Normal, Deep), the current one ticked. Choosing one sets it (same call as
   /effort) and the label updates. Tooltip: "How hard Muse thinks. Deep is slower and uses more
   credits."
6. **Send** stays at the far right, the normal VS Code primary button (blue), turns into **Stop**
   while Muse works (as now).
7. **Narrow panels:** the strip wraps onto a second row (pills move down first). Nothing squashes
   or hides.
8. Tests: the master shortcut list (every entry has id, label, description, handler); slot
   save/load/reset; swap-on-duplicate; effort menu reflects the supported levels.

## Done when
- Build + all tests pass.
- Installed: the input box shows the split with Save · Undo · New | four grey pills | Effort | Send.
- Hover anything in the strip → green. Right-click "Fork" → list → pick "Recap" → the pill now says
  Recap and runs a recap. Reload → still Recap. "Reset all to defaults" brings Goal/Side/Fork/Usage back.
- "Effort: Normal ▾" → pick Deep → the label says "Effort: Deep" and the next reply uses it.
- Works in a light and a dark theme.

## Handover
Plain English + commit `08e: input bar`. Screenshot for the README.
