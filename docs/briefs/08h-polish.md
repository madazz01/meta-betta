# 08h — Polish before freeze

Read `AGENTS.md` first. Start on a clean tree. This is the last brief before the feature
freeze, so keep it small: no new features, only these three fixes.

## Why
Bryan's Friday testing turned up three rough edges. After this brief, we package (brief 10).

## Build
1. **Save: don't offer to commit an ignored brain.** In `offerGitCommit`
   (`chatController.ts`), after the `rev-parse` check, run `git check-ignore -q brain`.
   Exit code 0 means brain/ is ignored. In that case, return quietly: no "Also commit the
   brain?" prompt and no error. (The meta-betta repo ignores brain/ on purpose, to keep
   personal notes off GitHub.) Any other git error still shows "Couldn't commit the brain."
2. **Don't yank the chat while the user is reading.** Today `scrollToBottom()` always jumps
   to the bottom, 17 times in `chat.js`. Change it so it only follows new output when the
   user is already at the bottom (within about 60px). If they've scrolled up, leave the view
   where it is and show a small grey **"↓ New"** pill above the input box. Clicking the pill,
   or scrolling back down by hand, hides it and starts following again. Sending a message
   keeps the view where it is too (Bryan: you often type while reading back). Keep the pill calm: grey, one word, no count.
3. **Throwaway redirects must really be throwaway.** In `lib/approvals.ts`, `THROWAWAY_NULL`
   uses `\$null\b`, so `>$null.txt` counts as "output thrown away". It's really a write to a
   file called `$null.txt`. The same goes for `| Out-Null.ps1`-style tails and
   `2>/dev/null.txt`. Only strip a match when it ends the command or is followed by
   whitespace, `;`, `|`, `)` or `&`. Use a lookahead like `(?=$|[\s;|)&])` in place of `\b`,
   on both regexes. Check the argv side (`isThrowawayToken`) too.
4. **Tests:**
   - Save: brain ignored → no prompt; brain tracked → prompt as before. A pure helper is fine.
   - Scroll: a pure "should follow?" helper (distance from the bottom, just sent).
   - Redirects: `>$null.txt`, `2>$null.log`, `2>/dev/null.txt`, `| Out-Null.ps1` are **not**
     stripped. `2>$null`, `>$null;`, `*>$null)`, `2>&1 |`, `| Out-Null` at the end are still
     stripped. Auto mode asks for `Write-Output hi >$null.txt`.

## Done when
- Build and all tests pass.
- Save in the meta-betta folder shows no brain error.
- Scrolling up during a long reply stays put, and "↓ New" appears and works.
- The redirect cases above behave as listed.

## Handover
Plain English, plus the commit `08h: polish`. Commit only your own files. Don't push.
